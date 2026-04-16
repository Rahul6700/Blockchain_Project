// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LostFound — Trustless Blockchain Lost & Found Ledger
///
/// @notice Records every item report, ownership claim, and return as an
///         immutable on-chain transaction with no privileged admin account.
///
/// State machine (fully trustless):
///   Reported  -->  Claimed  -->  Returned
///
/// Who triggers each transition:
///   Reported  : Anyone (the person who found the item)
///   Claimed   : Anyone — the smart contract validates ownership via feature
///               hashes automatically; no human needed
///   Returned  : The original reporter (the finder who has physical custody)
///
/// Removing the admin role means no single account can block or manipulate
/// the lifecycle of any item. Every transition is either self-executed by
/// the finder or verified automatically by the contract.
contract LostFound {

    uint private _nonce;

    enum Status {
        Reported,  // 0 — Item registered by the finder; finder has custody
        Claimed,   // 1 — Ownership verified on-chain via feature hash matching
        Returned   // 2 — Finder confirms physical handoff to verified owner
    }

    struct Item {
        bytes32   itemId;
        address   reporter;   // the finder who has physical custody
        address   claimant;   // the verified owner
        string    description;
        bytes32[] featureHashes;
        uint      threshold;
        Status    status;
        uint      reportedAt;
        uint      claimedAt;
        uint      returnedAt;
        uint      claimRound; // increments each time reporter reopens claiming
    }

    struct ClaimAttempt {
        address claimant;
        bytes32 itemId;
        bool    success;
        uint    matchCount;
        uint    timestamp;
    }

    mapping(bytes32 => Item) private _items;

    // _attempted[itemId][round][claimant] — one attempt per address per round
    mapping(bytes32 => mapping(uint => mapping(address => bool))) private _attempted;

    bytes32[] public itemIds;
    ClaimAttempt[] public claimHistory;

    // ======================== Events ========================

    /// @notice Emitted when a finder registers a found item on-chain.
    event ItemReported(
        bytes32 indexed itemId,
        address indexed reporter,
        string  description,
        uint    timestamp
    );

    /// @notice Emitted on every claim attempt (success or failure).
    ///         Provides a permanent, tamper-proof audit trail.
    event ClaimSubmitted(
        bytes32 indexed itemId,
        address indexed claimant,
        bool    success,
        uint    matchCount,
        uint    threshold,
        uint    timestamp
    );

    /// @notice Emitted when the feature-hash check succeeds and ownership
    ///         is verified automatically by the contract.
    event ItemClaimed(
        bytes32 indexed itemId,
        address indexed claimant,
        uint    timestamp
    );

    /// @notice Emitted when the finder (reporter) confirms physical handoff.
    event ItemReturned(
        bytes32 indexed itemId,
        address indexed returnedTo,
        uint    timestamp
    );

    /// @notice Emitted when the reporter reopens claiming for a new round.
    event ClaimingReopened(
        bytes32 indexed itemId,
        address indexed reporter,
        uint    newRound,
        uint    timestamp
    );

    // ======================== Modifiers ========================

    modifier itemExists(bytes32 _itemId) {
        require(_items[_itemId].reportedAt != 0, "Item does not exist");
        _;
    }

    // ======================== Core Functions ========================

    /// @dev Collision-resistant unique ID using timestamp, caller, and nonce.
    function _generateItemId() private returns (bytes32) {
        _nonce++;
        return keccak256(abi.encodePacked(block.timestamp, msg.sender, _nonce));
    }

    /// @notice Register a found item on-chain. The caller (finder) implicitly
    ///         declares physical custody of the item.
    /// @param _description   Human-readable description visible to all users
    /// @param _featureHashes keccak256 hashes of secret identifying features;
    ///                       plaintext is never stored on-chain
    /// @param _threshold     Minimum matching hashes required to approve a claim
    /// @return The unique bytes32 identifier assigned to this item
    function reportItem(
        string    calldata _description,
        bytes32[] calldata _featureHashes,
        uint               _threshold
    ) external returns (bytes32) {
        require(bytes(_description).length > 0, "Description cannot be empty");
        require(_featureHashes.length > 0, "At least one feature hash required");
        require(
            _threshold > 0 && _threshold <= _featureHashes.length,
            "Threshold must be between 1 and the number of features"
        );

        bytes32 itemId = _generateItemId();

        Item storage newItem = _items[itemId];
        newItem.itemId      = itemId;
        newItem.reporter    = msg.sender;
        newItem.description = _description;
        newItem.threshold   = _threshold;
        newItem.status      = Status.Reported;
        newItem.reportedAt  = block.timestamp;
        newItem.claimRound  = 0;

        for (uint i = 0; i < _featureHashes.length; i++) {
            newItem.featureHashes.push(_featureHashes[i]);
        }

        itemIds.push(itemId);

        emit ItemReported(itemId, msg.sender, _description, block.timestamp);
        return itemId;
    }

    /// @notice Submit an ownership claim by providing plaintext features.
    ///         The contract hashes each string on-chain using keccak256 and
    ///         compares the results against the stored feature hashes.
    ///         If the number of matching hashes meets the threshold, ownership
    ///         is verified automatically — no human intermediary is needed.
    ///
    ///         Valid transition: Reported --> Claimed
    ///
    /// @param _itemId   The unique item identifier
    /// @param _features Plaintext feature strings to prove ownership
    /// @return Whether the claim was approved
    function claimItem(
        bytes32  _itemId,
        string[] calldata _features
    ) external itemExists(_itemId) returns (bool) {
        Item storage item = _items[_itemId];
        require(item.status == Status.Reported, "Item must be in Reported state to claim");
        require(_features.length > 0, "Must provide at least one feature");

        // Rule 1: reporter cannot claim their own item
        require(
            msg.sender != item.reporter,
            "You reported this item and cannot claim it yourself"
        );

        // Rule 2: each address gets exactly one attempt per round
        require(
            !_attempted[_itemId][item.claimRound][msg.sender],
            "You have already attempted to claim this item in the current round"
        );
        _attempted[_itemId][item.claimRound][msg.sender] = true;

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

        claimHistory.push(ClaimAttempt({
            claimant:   msg.sender,
            itemId:     _itemId,
            success:    success,
            matchCount: matchCount,
            timestamp:  block.timestamp
        }));

        emit ClaimSubmitted(
            _itemId,
            msg.sender,
            success,
            matchCount,
            item.threshold,
            block.timestamp
        );

        if (success) {
            item.claimant  = msg.sender;
            item.status    = Status.Claimed;
            item.claimedAt = block.timestamp;
            emit ItemClaimed(_itemId, msg.sender, block.timestamp);
        }

        return success;
    }

    /// @notice The original reporter (the finder who has physical custody)
    ///         confirms they have handed the item back to the verified owner.
    ///         Only the reporter can call this because they are the one holding
    ///         the item — no privileged admin account is needed.
    ///
    ///         Valid transition: Claimed --> Returned
    ///
    /// @param _itemId The unique item identifier
    function confirmReturn(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(item.status == Status.Claimed, "Item must be in Claimed state to confirm return");
        require(
            msg.sender == item.reporter,
            "Only the finder (original reporter) can confirm the physical handoff"
        );

        item.status     = Status.Returned;
        item.returnedAt = block.timestamp;

        emit ItemReturned(_itemId, item.claimant, block.timestamp);
    }

    /// @notice Reporter reopens claiming by starting a new round.
    ///         All previous claimants' attempts are preserved on-chain (audit
    ///         trail) but the new round number resets everyone's eligibility.
    ///         Only callable by the reporter while the item is still Reported.
    ///
    /// @param _itemId The unique item identifier
    function reopenClaiming(bytes32 _itemId) external itemExists(_itemId) {
        Item storage item = _items[_itemId];
        require(
            msg.sender == item.reporter,
            "Only the reporter can reopen claiming"
        );
        require(
            item.status == Status.Reported,
            "Can only reopen claiming on items in Reported state"
        );
        item.claimRound++;
        emit ClaimingReopened(_itemId, msg.sender, item.claimRound, block.timestamp);
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
        uint    returnedAt,
        uint    claimRound
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
            item.returnedAt,
            item.claimRound
        );
    }

    /// @notice Returns true if the address already used their attempt this round.
    function hasAttemptedClaim(bytes32 _itemId, address _claimant)
        external view itemExists(_itemId) returns (bool)
    {
        Item storage item = _items[_itemId];
        return _attempted[_itemId][item.claimRound][_claimant];
    }

    /// @notice Returns the current claim round number for an item.
    function getClaimRound(bytes32 _itemId)
        external view itemExists(_itemId) returns (uint)
    {
        return _items[_itemId].claimRound;
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
