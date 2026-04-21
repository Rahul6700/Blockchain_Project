// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LostFound — Trustless Blockchain Lost & Found Ledger
///
/// State machine:
///   Reported --> Claimed --> HandoffPending --> Returned
///
/// Rules:
///   1. Reporter cannot claim their own item.
///   2. Each address gets one attempt per item; reporter can selectively
///      re-allow specific failed claimants (max MAX_REOPENS_PER_CLAIMANT).
///      Other claimants are unaffected by any reopen.
///   3. Two-step handoff: reporter confirms first, then claimant confirms receipt.
///   4. Either party can request mutual cancellation of a pending handoff.
///      The OTHER party must approve. Every request/approval is permanently
///      recorded on-chain as a public audit trail.
contract LostFound {

    uint private _nonce;

    /// @notice Max times a reporter can reopen claiming for one claimant on one item.
    uint public constant MAX_REOPENS_PER_CLAIMANT = 3;

    enum Status {
        Reported,       // 0 — item registered; reporter has physical custody
        Claimed,        // 1 — ownership verified via feature hashes
        HandoffPending, // 2 — reporter confirmed handoff; waiting for claimant receipt
        Returned        // 3 — both parties confirmed; complete
    }

    struct Item {
        bytes32   itemId;
        address   reporter;    // finder who has physical custody
        address   claimant;    // verified owner (set on successful claim)
        string    description;
        bytes32[] featureHashes;
        uint      threshold;
        Status    status;
        uint      reportedAt;
        uint      claimedAt;
        uint      handoffAt;   // when reporter confirmed handoff
        uint      returnedAt;
    }

    /// @notice Per-claimant tracking for a specific item.
    struct ClaimantInfo {
        uint failedAttempts; // total failed attempts (visible to reporter)
        bool blocked;        // true after each attempt; reset by reporter reopen
        uint reopensUsed;    // how many times reporter has re-allowed this claimant
    }

    /// @notice Permanent on-chain record of one handoff cancellation event.
    struct CancelRecord {
        address requester;   // who requested the cancel
        uint    requestedAt;
        bool    approved;    // false = open/ignored, true = approved and actioned
        address approver;    // who approved (zero if not yet approved)
        uint    approvedAt;
    }

    struct ClaimAttempt {
        address claimant;
        bytes32 itemId;
        bool    success;
        uint    matchCount;
        uint    timestamp;
    }

    // ======================== Storage ========================

    mapping(bytes32 => Item) private _items;

    // itemId → claimant address → tracking info
    mapping(bytes32 => mapping(address => ClaimantInfo)) private _claimantInfo;
    // ordered list of all addresses that have attempted per item
    mapping(bytes32 => address[]) private _itemClaimants;
    // dedup guard — prevents same address appearing twice in _itemClaimants
    mapping(bytes32 => mapping(address => bool)) private _isKnownClaimant;

    // cancel system
    mapping(bytes32 => CancelRecord[]) private _cancelRecords;
    mapping(bytes32 => bool)           private _hasPendingCancel;
    mapping(bytes32 => uint)           private _pendingCancelIdx;

    bytes32[]     public itemIds;
    ClaimAttempt[] public claimHistory;

    // ======================== Events ========================

    event ItemReported(
        bytes32 indexed itemId,
        address indexed reporter,
        string  description,
        uint    timestamp
    );
    event ClaimSubmitted(
        bytes32 indexed itemId,
        address indexed claimant,
        bool    success,
        uint    matchCount,
        uint    threshold,
        uint    timestamp
    );
    event ItemClaimed(
        bytes32 indexed itemId,
        address indexed claimant,
        uint    timestamp
    );
    event ClaimantReopened(
        bytes32 indexed itemId,
        address indexed reporter,
        address indexed claimant,
        uint    reopensRemaining,
        uint    timestamp
    );
    event HandoffConfirmed(
        bytes32 indexed itemId,
        address indexed reporter,
        uint    timestamp
    );
    event ReceiptConfirmed(
        bytes32 indexed itemId,
        address indexed claimant,
        uint    timestamp
    );
    event CancelHandoffRequested(
        bytes32 indexed itemId,
        address indexed requester,
        uint    timestamp
    );
    event CancelHandoffApproved(
        bytes32 indexed itemId,
        address indexed requester,
        address indexed approver,
        uint    timestamp
    );

    // ======================== Modifiers ========================

    modifier itemExists(bytes32 _itemId) {
        require(_items[_itemId].reportedAt != 0, "Item does not exist");
        _;
    }

    // ======================== Core Functions ========================

    function _generateItemId() private returns (bytes32) {
        _nonce++;
        return keccak256(abi.encodePacked(block.timestamp, msg.sender, _nonce));
    }

    /// @notice Register a found item on-chain.
    function reportItem(
        string    calldata _description,
        bytes32[] calldata _featureHashes,
        uint               _threshold
    ) external returns (bytes32) {
        require(bytes(_description).length > 0, "Description cannot be empty");
        require(_featureHashes.length > 0, "At least one feature hash required");
        require(
            _threshold > 0 && _threshold <= _featureHashes.length,
            "Threshold must be between 1 and number of features"
        );

        bytes32 itemId = _generateItemId();
        Item storage newItem = _items[itemId];
        newItem.itemId      = itemId;
        newItem.reporter    = msg.sender;
        newItem.description = _description;
        newItem.threshold   = _threshold;
        newItem.status      = Status.Reported;
        newItem.reportedAt  = block.timestamp;

        for (uint i = 0; i < _featureHashes.length; i++) {
            newItem.featureHashes.push(_featureHashes[i]);
        }
        itemIds.push(itemId);
        emit ItemReported(itemId, msg.sender, _description, block.timestamp);
        return itemId;
    }

    /// @notice Submit an ownership claim by providing plaintext features.
    ///         The contract hashes them and compares against stored hashes.
    ///         A claimant is blocked after every attempt (pass or fail).
    ///         Only the reporter can unblock a specific failed claimant.
    ///         Other claimants who haven't tried yet are completely unaffected.
    function claimItem(
        bytes32  _itemId,
        string[] calldata _features
    ) external itemExists(_itemId) returns (bool) {
        Item storage item = _items[_itemId];
        require(item.status == Status.Reported, "Item must be in Reported state to claim");
        require(_features.length > 0, "Must provide at least one feature");
        require(msg.sender != item.reporter, "You reported this item and cannot claim it yourself");

        ClaimantInfo storage info = _claimantInfo[_itemId][msg.sender];
        require(
            !info.blocked,
            "You have already attempted to claim this item. Wait for the reporter to reopen your attempt."
        );

        // Add to claimant list on first attempt
        if (!_isKnownClaimant[_itemId][msg.sender]) {
            _isKnownClaimant[_itemId][msg.sender] = true;
            _itemClaimants[_itemId].push(msg.sender);
        }

        // Block immediately — only reporter can unblock via reopenForClaimant
        info.blocked = true;

        uint matchCount = 0;
        for (uint i = 0; i < _features.length; i++) {
            bytes32 hashed = keccak256(abi.encodePacked(_features[i]));
            for (uint j = 0; j < item.featureHashes.length; j++) {
                if (hashed == item.featureHashes[j]) {
                    matchCount++;
                    break;
                }
            }
        }

        bool success = matchCount >= item.threshold;
        if (!success) {
            info.failedAttempts++;
        }

        claimHistory.push(ClaimAttempt({
            claimant:   msg.sender,
            itemId:     _itemId,
            success:    success,
            matchCount: matchCount,
            timestamp:  block.timestamp
        }));

        emit ClaimSubmitted(_itemId, msg.sender, success, matchCount, item.threshold, block.timestamp);

        if (success) {
            item.claimant  = msg.sender;
            item.status    = Status.Claimed;
            item.claimedAt = block.timestamp;
            emit ItemClaimed(_itemId, msg.sender, block.timestamp);
        }

        return success;
    }

    /// @notice Reporter unblocks one specific failed claimant, giving them
    ///         exactly one more attempt. All other claimants are unaffected.
    ///         Limited to MAX_REOPENS_PER_CLAIMANT per claimant per item.
    function reopenForClaimant(bytes32 _itemId, address _claimant)
        external itemExists(_itemId)
    {
        Item storage item = _items[_itemId];
        require(msg.sender == item.reporter, "Only the reporter can reopen for a claimant");
        require(item.status == Status.Reported, "Item must be in Reported state");
        require(_isKnownClaimant[_itemId][_claimant], "This address has not attempted to claim this item");

        ClaimantInfo storage info = _claimantInfo[_itemId][_claimant];
        require(info.blocked, "This claimant is not currently blocked");
        require(
            info.reopensUsed < MAX_REOPENS_PER_CLAIMANT,
            "Maximum reopens already granted for this claimant"
        );

        info.blocked = false;
        info.reopensUsed++;

        uint remaining = MAX_REOPENS_PER_CLAIMANT - info.reopensUsed;
        emit ClaimantReopened(_itemId, msg.sender, _claimant, remaining, block.timestamp);
    }

    // ======================== Two-Step Handoff ========================

    /// @notice Step 1 — Reporter confirms physical handoff. Claimed → HandoffPending.
    function confirmHandoff(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(item.status == Status.Claimed, "Item must be in Claimed state");
        require(msg.sender == item.reporter, "Only the reporter can confirm handoff");

        item.status    = Status.HandoffPending;
        item.handoffAt = block.timestamp;
        emit HandoffConfirmed(_itemId, msg.sender, block.timestamp);
    }

    /// @notice Step 2 — Claimant confirms they received the item. HandoffPending → Returned.
    function confirmReceipt(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(item.status == Status.HandoffPending, "Item must be in HandoffPending state");
        require(msg.sender == item.claimant, "Only the verified owner can confirm receipt");

        item.status     = Status.Returned;
        item.returnedAt = block.timestamp;
        emit ReceiptConfirmed(_itemId, msg.sender, block.timestamp);
    }

    // ======================== Mutual Cancel ========================

    /// @notice Either reporter or claimant can request cancellation of a pending handoff.
    ///         The OTHER party must approve for it to take effect.
    ///         Request stays open permanently if ignored — this is the public consequence.
    ///         Only one pending request allowed at a time.
    function requestCancelHandoff(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(item.status == Status.HandoffPending, "Item must be in HandoffPending state");
        require(
            msg.sender == item.reporter || msg.sender == item.claimant,
            "Only reporter or claimant can request cancellation"
        );
        require(!_hasPendingCancel[_itemId], "A cancel request is already open");

        _cancelRecords[_itemId].push(CancelRecord({
            requester:   msg.sender,
            requestedAt: block.timestamp,
            approved:    false,
            approver:    address(0),
            approvedAt:  0
        }));
        _hasPendingCancel[_itemId] = true;
        _pendingCancelIdx[_itemId] = _cancelRecords[_itemId].length - 1;

        emit CancelHandoffRequested(_itemId, msg.sender, block.timestamp);
    }

    /// @notice The OTHER party approves the open cancel request.
    ///         Item reverts to Claimed. Both addresses recorded permanently on-chain.
    function approveCancelHandoff(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(item.status == Status.HandoffPending, "Item must be in HandoffPending state");
        require(_hasPendingCancel[_itemId], "No pending cancel request");
        require(
            msg.sender == item.reporter || msg.sender == item.claimant,
            "Only reporter or claimant can approve cancellation"
        );

        uint idx = _pendingCancelIdx[_itemId];
        CancelRecord storage rec = _cancelRecords[_itemId][idx];
        require(msg.sender != rec.requester, "You cannot approve your own cancel request");

        rec.approved   = true;
        rec.approver   = msg.sender;
        rec.approvedAt = block.timestamp;
        _hasPendingCancel[_itemId] = false;

        // Revert to Claimed; clear handoff timestamp
        item.status    = Status.Claimed;
        item.handoffAt = 0;

        emit CancelHandoffApproved(_itemId, rec.requester, msg.sender, block.timestamp);
    }

    // ======================== View Functions ========================

    function getItem(bytes32 _itemId) external view returns (
        bytes32 itemId,
        address reporter,
        address claimant,
        string  memory description,
        uint    threshold,
        uint    featureCount,
        uint8   status,
        uint    reportedAt,
        uint    claimedAt,
        uint    handoffAt,
        uint    returnedAt
    ) {
        Item storage item = _items[_itemId];
        return (
            item.itemId,
            item.reporter,
            item.claimant,
            item.description,
            item.threshold,
            item.featureHashes.length,
            uint8(item.status),
            item.reportedAt,
            item.claimedAt,
            item.handoffAt,
            item.returnedAt
        );
    }

    /// @notice All addresses that have ever attempted to claim this item.
    ///         Reporter uses this to see who tried and manage selective reopens.
    function getItemClaimants(bytes32 _itemId)
        external view itemExists(_itemId) returns (address[] memory)
    {
        return _itemClaimants[_itemId];
    }

    /// @notice Full tracking info for one claimant on one item.
    function getClaimantInfo(bytes32 _itemId, address _claimant)
        external view itemExists(_itemId)
        returns (
            uint failedAttempts,
            bool blocked,
            uint reopensUsed,
            uint reopensRemaining
        )
    {
        ClaimantInfo storage info = _claimantInfo[_itemId][_claimant];
        uint remaining = info.reopensUsed >= MAX_REOPENS_PER_CLAIMANT
            ? 0
            : MAX_REOPENS_PER_CLAIMANT - info.reopensUsed;
        return (info.failedAttempts, info.blocked, info.reopensUsed, remaining);
    }

    /// @notice Current handoff/cancel state — used by UI to render cancel buttons.
    function getHandoffInfo(bytes32 _itemId)
        external view itemExists(_itemId)
        returns (
            bool    hasPendingCancel,
            address cancelRequester,
            uint    cancelRequestedAt,
            uint    totalCancels
        )
    {
        bool pending = _hasPendingCancel[_itemId];
        address requester = address(0);
        uint    requestedAt = 0;
        if (pending) {
            CancelRecord storage rec = _cancelRecords[_itemId][_pendingCancelIdx[_itemId]];
            requester   = rec.requester;
            requestedAt = rec.requestedAt;
        }
        return (pending, requester, requestedAt, _cancelRecords[_itemId].length);
    }

    /// @notice One cancel record by index — full public audit trail.
    function getCancelRecord(bytes32 _itemId, uint _index)
        external view itemExists(_itemId)
        returns (
            address requester,
            uint    requestedAt,
            bool    approved,
            address approver,
            uint    approvedAt
        )
    {
        require(_index < _cancelRecords[_itemId].length, "Index out of bounds");
        CancelRecord storage rec = _cancelRecords[_itemId][_index];
        return (rec.requester, rec.requestedAt, rec.approved, rec.approver, rec.approvedAt);
    }

    function getCancelCount(bytes32 _itemId)
        external view itemExists(_itemId) returns (uint)
    {
        return _cancelRecords[_itemId].length;
    }

    function getFeatureHashes(bytes32 _itemId) external view returns (bytes32[] memory) {
        return _items[_itemId].featureHashes;
    }

    function getItemCount() external view returns (uint) {
        return itemIds.length;
    }

    function getItemIdAtIndex(uint _index) external view returns (bytes32) {
        require(_index < itemIds.length, "Index out of bounds");
        return itemIds[_index];
    }

    function getClaimHistoryCount() external view returns (uint) {
        return claimHistory.length;
    }

    function getClaimAttempt(uint _index) external view returns (
        address claimant,
        bytes32 itemId,
        bool    success,
        uint    matchCount,
        uint    timestamp
    ) {
        require(_index < claimHistory.length, "Index out of bounds");
        ClaimAttempt storage attempt = claimHistory[_index];
        return (
            attempt.claimant,
            attempt.itemId,
            attempt.success,
            attempt.matchCount,
            attempt.timestamp
        );
    }
}
