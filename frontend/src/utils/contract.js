import { ethers } from "ethers";

import deployedAddr from "./deployedAddress.json";
const CONTRACT_ADDRESS = deployedAddr.address;

// Trustless 3-state contract: Reported -> Claimed -> Returned
// No admin account. All transitions are self-executed or automatically
// validated by the smart contract.
const CONTRACT_ABI = [
  // State-transition functions
  "function reportItem(string _description, bytes32[] _featureHashes, uint256 _threshold) returns (bytes32)",
  "function claimItem(bytes32 _itemId, string[] _features) returns (bool)",
  "function confirmReturn(bytes32 _itemId)",
  "function reopenClaiming(bytes32 _itemId)",

  // View functions
  "function getItem(bytes32 _itemId) view returns (bytes32 itemId, address reporter, address claimant, string description, uint256 threshold, uint256 featureCount, uint8 status, uint256 reportedAt, uint256 claimedAt, uint256 returnedAt, uint256 claimRound)",
  "function hasAttemptedClaim(bytes32 _itemId, address _claimant) view returns (bool)",
  "function getClaimRound(bytes32 _itemId) view returns (uint256)",
  "function getFeatureHashes(bytes32 _itemId) view returns (bytes32[])",
  "function getItemCount() view returns (uint256)",
  "function getItemIdAtIndex(uint256 _index) view returns (bytes32)",
  "function getClaimHistoryCount() view returns (uint256)",
  "function getClaimAttempt(uint256 _index) view returns (address claimant, bytes32 itemId, bool success, uint256 matchCount, uint256 timestamp)",
  "function itemIds(uint256) view returns (bytes32)",

  // Events (indexed for on-chain audit trail)
  "event ItemReported(bytes32 indexed itemId, address indexed reporter, string description, uint256 timestamp)",
  "event ClaimSubmitted(bytes32 indexed itemId, address indexed claimant, bool success, uint256 matchCount, uint256 threshold, uint256 timestamp)",
  "event ItemClaimed(bytes32 indexed itemId, address indexed claimant, uint256 timestamp)",
  "event ItemReturned(bytes32 indexed itemId, address indexed returnedTo, uint256 timestamp)",
  "event ClaimingReopened(bytes32 indexed itemId, address indexed reporter, uint256 newRound, uint256 timestamp)",
];

export const getProvider = () => {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  return new ethers.BrowserProvider(window.ethereum);
};

export const getContract = async () => {
  const provider = getProvider();
  const signer = await provider.getSigner();
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
};

export const getReadOnlyContract = () => {
  const provider = getProvider();
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
};

export const checkContractDeployed = async () => {
  try {
    const provider = getProvider();
    const code = await provider.getCode(CONTRACT_ADDRESS);
    return code !== "0x";
  } catch {
    return false;
  }
};

export { CONTRACT_ADDRESS, CONTRACT_ABI };
