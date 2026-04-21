import { useState, useEffect, useCallback, useRef } from "react";
import "./App.css";
import {
  getContract,
  getReadOnlyContract,
  checkContractDeployed,
  CONTRACT_ADDRESS,
} from "./utils/contract";
import { ethers } from "ethers";

// 4-state machine: Reported → Claimed → HandoffPending → Returned
const STATUS_LABELS = ["Reported", "Claimed", "Handoff Pending", "Returned"];
const HARDHAT_CHAIN_ID = "0x7a69"; // 31337

function truncateAddress(addr) {
  if (!addr || addr === ethers.ZeroAddress) return "";
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

function truncateId(id) {
  if (!id) return "";
  return `${id.substring(0, 10)}...${id.substring(id.length - 8)}`;
}

function formatTimestamp(ts) {
  if (!ts || ts === 0) return null;
  return new Date(ts * 1000).toLocaleString();
}

/** Normalize bytes32 from ethers so React keys and contract calls always match. */
function normalizeItemId(id) {
  if (id == null || id === "") return "";
  try {
    return ethers.hexlify(id).toLowerCase();
  } catch {
    return String(id).toLowerCase();
  }
}

function itemStatus(item) {
  const s = item?.status;
  if (s === undefined || s === null) return -1;
  return typeof s === "bigint" ? Number(s) : Number(s);
}

function StatusTimeline({ item }) {
  const st = itemStatus(item);
  const steps = [
    { label: "Reported",   time: item.reportedAt },
    { label: "Claimed",    time: item.claimedAt  },
    { label: "Handoff",    time: item.handoffAt  },
    { label: "Returned",   time: item.returnedAt  },
  ];

  return (
    <div className="timeline">
      {steps.map((step, i) => {
        const isCompleted = st > i;
        const isActive    = st === i;
        return (
          <div
            key={i}
            className={`timeline-step${isCompleted ? " completed" : ""}${isActive ? " active" : ""}`}
          >
            <div className="timeline-dot">
              {isCompleted ? "\u2713" : i + 1}
            </div>
            <div className="timeline-label">{step.label}</div>
            {step.time > 0 && (
              <div className="timeline-time">{formatTimestamp(step.time)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [account,      setAccount]      = useState("");
  const [items,        setItems]        = useState([]);
  const [filter,       setFilter]       = useState("all");
  const [loading,      setLoading]      = useState(false);
  const [networkOk,    setNetworkOk]    = useState(true);
  const [contractOk,   setContractOk]   = useState(true);
  const [networkError, setNetworkError] = useState("");

  const [description,   setDescription]   = useState("");
  const [features,      setFeatures]      = useState("");
  const [threshold,     setThreshold]     = useState("");
  const [claimFeatures, setClaimFeatures] = useState({});
  /** Tracks which itemId (normalized) has a tx in flight so buttons cannot double-fire. */
  const [pendingIds, setPendingIds] = useState(() => new Set());

  const eventContractRef = useRef(null);

  // -------------------- Network Checks --------------------

  const verifyNetwork = useCallback(async () => {
    if (!window.ethereum) {
      setNetworkOk(false);
      setNetworkError("MetaMask is not installed. Please install MetaMask to continue.");
      return false;
    }
    try {
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (chainId !== HARDHAT_CHAIN_ID) {
        setNetworkOk(false);
        setNetworkError(
          `Wrong network (Chain ID: ${parseInt(chainId, 16)}). Switch MetaMask to Hardhat Localhost (Chain ID: 31337).`
        );
        return false;
      }
      const deployed = await checkContractDeployed();
      if (!deployed) {
        setNetworkOk(true);
        setContractOk(false);
        setNetworkError(
          "Contract not found at " + truncateAddress(CONTRACT_ADDRESS) +
          ". Run: npx hardhat run scripts/deploy.js --network localhost"
        );
        return false;
      }
      setNetworkOk(true);
      setContractOk(true);
      setNetworkError("");
      return true;
    } catch (err) {
      console.error("Network check failed:", err);
      setNetworkOk(false);
      setNetworkError("Cannot reach the blockchain node. Is 'npx hardhat node' running?");
      return false;
    }
  }, []);

  // -------------------- Wallet --------------------

  const connectWallet = async () => {
    if (!window.ethereum) {
      alert("Please install MetaMask to use this application.");
      return;
    }
    try {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: HARDHAT_CHAIN_ID }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: HARDHAT_CHAIN_ID,
              chainName: "Hardhat Localhost",
              rpcUrls: ["http://127.0.0.1:8545"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            }],
          });
        } else {
          throw switchErr;
        }
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      setAccount(accounts[0]);
      localStorage.removeItem("isDisconnected");
      await verifyNetwork();
    } catch (err) {
      console.error("Wallet connection failed:", err);
      alert("Failed to connect wallet. See console for details.");
    }
  };

  const disconnectWallet = () => {
    setAccount("");
    setItems([]);
    localStorage.setItem("isDisconnected", "true");
  };

  // -------------------- Data Loading --------------------

  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      const contract = await getContract();
      const count = await contract.getItemCount();
      const allItems = [];

      for (let i = 0; i < Number(count); i++) {
        const rawId = await contract.getItemIdAtIndex(i);
        const idNorm = normalizeItemId(rawId);
        const data = await contract.getItem(idNorm);
        const st = Number(data.status);
        const reporterAddr = data.reporter.toLowerCase();
        const isCurrentReporter = account && reporterAddr === account.toLowerCase();

        // Check if current user is blocked from claiming (only relevant in Reported state)
        let blocked = false;
        if (account && st === 0 && !isCurrentReporter) {
          try {
            const ci = await contract.getClaimantInfo(idNorm, account);
            blocked = ci.blocked;
          } catch { /* ignore */ }
        }

        // Load full claimant list for the reporter's view (only in Reported state)
        let claimants = [];
        if (isCurrentReporter && st === 0) {
          try {
            const addrs = await contract.getItemClaimants(idNorm);
            for (const addr of addrs) {
              const ci = await contract.getClaimantInfo(idNorm, addr);
              claimants.push({
                address:          addr,
                failedAttempts:   Number(ci.failedAttempts),
                blocked:          ci.blocked,
                reopensUsed:      Number(ci.reopensUsed),
                reopensRemaining: Number(ci.reopensRemaining),
              });
            }
          } catch { /* ignore */ }
        }

        // Load handoff / cancel info for HandoffPending or Returned states
        let handoffInfo = {
          hasPendingCancel:  false,
          cancelRequester:   "",
          cancelRequestedAt: 0,
          totalCancels:      0,
          cancelRecords:     [],
        };
        if (st === 2 || st === 3) {
          try {
            const hi = await contract.getHandoffInfo(idNorm);
            const totalCancels = Number(hi.totalCancels);
            const cancelRecords = [];
            for (let c = 0; c < totalCancels; c++) {
              const rec = await contract.getCancelRecord(idNorm, c);
              cancelRecords.push({
                requester:   rec.requester,
                requestedAt: Number(rec.requestedAt),
                approved:    rec.approved,
                approver:    rec.approver,
                approvedAt:  Number(rec.approvedAt),
              });
            }
            handoffInfo = {
              hasPendingCancel:  hi.hasPendingCancel,
              cancelRequester:   hi.cancelRequester,
              cancelRequestedAt: Number(hi.cancelRequestedAt),
              totalCancels,
              cancelRecords,
            };
          } catch { /* ignore */ }
        }

        allItems.push({
          itemId:       idNorm,
          reporter:     data.reporter,
          claimant:     data.claimant,
          description:  data.description,
          threshold:    Number(data.threshold),
          featureCount: Number(data.featureCount),
          status:       st,
          reportedAt:   Number(data.reportedAt),
          claimedAt:    Number(data.claimedAt),
          handoffAt:    Number(data.handoffAt),
          returnedAt:   Number(data.returnedAt),
          blocked,
          claimants,
          handoffInfo,
        });
      }
      setItems(allItems);
    } catch (err) {
      console.error("Failed to load items:", err);
      if (err?.message?.includes("could not decode result data")) {
        setContractOk(false);
        setNetworkError(
          "Contract mismatch. Redeploy: npx hardhat run scripts/deploy.js --network localhost"
        );
      }
    } finally {
      setLoading(false);
    }
  }, [account]);

  // -------------------- Effects --------------------

  useEffect(() => {
    const init = async () => {
      if (
        window.ethereum &&
        localStorage.getItem("isDisconnected") !== "true"
      ) {
        try {
          const accounts = await window.ethereum.request({ method: "eth_accounts" });
          if (accounts.length > 0) setAccount(accounts[0]);
        } catch (err) {
          console.error(err);
        }
      }
      await verifyNetwork();
    };
    init();
  }, [verifyNetwork]);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccountsChanged = (accounts) => {
      if (accounts.length > 0) setAccount(accounts[0]);
      else disconnectWallet();
    };
    const handleChainChanged = () => verifyNetwork();
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [verifyNetwork]);

  useEffect(() => {
    if (account && networkOk && contractOk) loadItems();
  }, [account, networkOk, contractOk, loadItems]);

  useEffect(() => {
    if (!account || !networkOk || !contractOk) return;
    let contract;
    try {
      contract = getReadOnlyContract();
      eventContractRef.current = contract;
    } catch {
      return;
    }
    const reload = () => loadItems();
    contract.on("ItemReported",          reload);
    contract.on("ItemClaimed",           reload);
    contract.on("HandoffConfirmed",      reload);
    contract.on("ReceiptConfirmed",      reload);
    contract.on("ClaimSubmitted",        reload);
    contract.on("ClaimantReopened",      reload);
    contract.on("CancelHandoffRequested",reload);
    contract.on("CancelHandoffApproved", reload);
    return () => {
      if (eventContractRef.current) {
        eventContractRef.current.removeAllListeners();
      }
    };
  }, [account, networkOk, contractOk, loadItems]);

  // -------------------- Helpers --------------------

  const parseFeatures = (input) =>
    input.split(",").map((f) => f.trim()).filter((f) => f.length > 0);

  const friendlyError = (err) => {
    const msg = err?.reason || err?.data?.message || err?.message || "";
    const lower = msg.toLowerCase();
    if (lower.includes("nonce too high"))
      return "Nonce mismatch. MetaMask: Settings → Advanced → Clear activity tab data, then retry.";
    if (lower.includes("cannot claim it yourself"))
      return "You reported this item — you cannot claim your own report.";
    if (lower.includes("already attempted to claim"))
      return "You have already submitted a claim. Wait for the reporter to reopen your attempt.";
    if (lower.includes("only the reporter can confirm handoff"))
      return "Only the wallet that reported this item can confirm the physical handoff.";
    if (lower.includes("only the verified owner can confirm receipt"))
      return "Only the verified owner (claimant) can confirm receipt.";
    if (lower.includes("only the reporter can reopen"))
      return "Only the reporter can selectively reopen claiming for a claimant.";
    if (lower.includes("maximum reopens already granted"))
      return `This claimant has reached the maximum number of reopens allowed.`;
    if (lower.includes("this address has not attempted"))
      return "This address hasn't attempted to claim this item yet.";
    if (lower.includes("cancel request is already open"))
      return "A cancel request is already open. The other party must respond to it first.";
    if (lower.includes("no pending cancel request"))
      return "There is no open cancel request to approve.";
    if (lower.includes("cannot approve your own cancel"))
      return "You cannot approve your own cancel request — the other party must approve.";
    if (lower.includes("reported state to claim"))
      return "This item is not open for claims anymore (already claimed or returned). Click Refresh.";
    if (lower.includes("must be in claimed state"))
      return "Handoff can only be confirmed while the item is in Claimed state. Click Refresh.";
    if (lower.includes("must be in handoffpending state"))
      return "This action requires the item to be in Handoff Pending state. Click Refresh.";
    if (lower.includes("item does not exist"))
      return "This item ID was not found on the chain. Redeploy the contract or refresh.";
    if (lower.includes("user rejected") || lower.includes("user denied"))
      return "Transaction was rejected in MetaMask.";
    return msg || "Unknown error";
  };

  // -------------------- Contract Interactions --------------------

  const reportItem = async () => {
    if (!description.trim()) { alert("Enter a description for the item."); return; }
    const featureList = parseFeatures(features);
    if (featureList.length === 0) { alert("Enter at least one identifying feature."); return; }
    const thresholdNum = parseInt(threshold);
    if (!thresholdNum || thresholdNum < 1 || thresholdNum > featureList.length) {
      alert(`Threshold must be between 1 and ${featureList.length}.`);
      return;
    }
    try {
      const contract = await getContract();
      const hashed = featureList.map((f) => ethers.keccak256(ethers.toUtf8Bytes(f)));
      const tx = await contract.reportItem(description.trim(), hashed, thresholdNum);
      await tx.wait();
      setDescription(""); setFeatures(""); setThreshold("");
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Report failed: " + friendlyError(err));
    }
  };

  const claimItem = async (rawItemId) => {
    const itemId = normalizeItemId(rawItemId);
    const featureInput = claimFeatures[itemId] || "";
    const featureList = parseFeatures(featureInput);
    if (featureList.length === 0) {
      alert("Enter your identifying features to prove ownership.");
      return;
    }
    if (pendingIds.has(itemId)) return;

    try {
      const contract = await getContract();
      const onChain = await contract.getItem(itemId);
      const st = Number(onChain.status);
      if (st !== 0) {
        await loadItems();
        alert(
          st === 1
            ? "This item is already claimed. Use Refresh if the list looked outdated."
            : "This item is already returned. Use Refresh if the list looked outdated."
        );
        return;
      }

      setPendingIds((prev) => new Set(prev).add(itemId));
      const tx = await contract.claimItem(itemId, featureList);
      const receipt = await tx.wait();

      const claimEvent = receipt.logs
        .map((log) => {
          try {
            return contract.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ClaimSubmitted");

      if (claimEvent) {
        const matched = Number(claimEvent.args.matchCount);
        const needed = Number(claimEvent.args.threshold);
        if (claimEvent.args.success) {
          alert(
            `Claim APPROVED! Matched ${matched}/${needed} features. Ownership verified on-chain.`
          );
        } else {
          alert(
            `Claim DENIED. Matched ${matched}/${needed} features required. Copy the exact words you used when reporting (case and spaces matter).`
          );
        }
      }
      setClaimFeatures((prev) => ({ ...prev, [itemId]: "" }));
      await loadItems();
    } catch (err) {
      console.error(err);
      await loadItems();
      alert("Claim failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  };

  // Two-step handoff: Step 1 — reporter confirms physical handoff
  const confirmHandoff = async (rawItemId) => {
    const itemId = normalizeItemId(rawItemId);
    if (pendingIds.has(itemId)) return;
    try {
      setPendingIds((prev) => new Set(prev).add(itemId));
      const contract = await getContract();
      const tx = await contract.confirmHandoff(itemId);
      await tx.wait();
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Confirm handoff failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(itemId); return n; });
    }
  };

  // Two-step handoff: Step 2 — claimant confirms they received the item
  const confirmReceipt = async (rawItemId) => {
    const itemId = normalizeItemId(rawItemId);
    if (pendingIds.has(itemId)) return;
    try {
      setPendingIds((prev) => new Set(prev).add(itemId));
      const contract = await getContract();
      const tx = await contract.confirmReceipt(itemId);
      await tx.wait();
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Confirm receipt failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(itemId); return n; });
    }
  };

  // Selective reopen: reporter unblocks one specific failed claimant
  const reopenForClaimant = async (rawItemId, claimantAddr) => {
    const itemId = normalizeItemId(rawItemId);
    const key = `${itemId}-${claimantAddr}`;
    if (pendingIds.has(key)) return;
    try {
      setPendingIds((prev) => new Set(prev).add(key));
      const contract = await getContract();
      const tx = await contract.reopenForClaimant(itemId, claimantAddr);
      await tx.wait();
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Reopen failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  // Mutual cancel: request cancellation of a pending handoff
  const requestCancelHandoff = async (rawItemId) => {
    const itemId = normalizeItemId(rawItemId);
    if (pendingIds.has(itemId)) return;
    try {
      setPendingIds((prev) => new Set(prev).add(itemId));
      const contract = await getContract();
      const tx = await contract.requestCancelHandoff(itemId);
      await tx.wait();
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Cancel request failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(itemId); return n; });
    }
  };

  // Mutual cancel: approve the other party's cancel request
  const approveCancelHandoff = async (rawItemId) => {
    const itemId = normalizeItemId(rawItemId);
    if (pendingIds.has(itemId)) return;
    try {
      setPendingIds((prev) => new Set(prev).add(itemId));
      const contract = await getContract();
      const tx = await contract.approveCancelHandoff(itemId);
      await tx.wait();
      await loadItems();
    } catch (err) {
      console.error(err);
      alert("Approve cancel failed: " + friendlyError(err));
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(itemId); return n; });
    }
  };

  // -------------------- Derived State --------------------

  const filteredItems = items.filter((item) =>
    filter === "all"
      ? true
      : itemStatus(item) === parseInt(filter, 10)
  );

  const statusCounts = items.reduce((acc, item) => {
    const s = itemStatus(item);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const hasError = !networkOk || !contractOk;

  // -------------------- Render --------------------

  return (
    <div className="app-wrapper">

      {/* ---------- Error Banner ---------- */}
      {networkError && (
        <div className="error-banner">
          <span className="error-icon">!</span>
          <span>{networkError}</span>
          <button
            className="error-retry"
            onClick={async () => {
              const ok = await verifyNetwork();
              if (ok && account) loadItems();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ---------- Navbar ---------- */}
      <nav className="navbar">
        <div className="nav-brand">BlockFind</div>
        <div className="nav-wallet">
          {account ? (
            <div className="nav-wallet-info">
              <span className="wallet-address">{truncateAddress(account)}</span>
              <button className="btn-secondary btn-sm" onClick={disconnectWallet}>
                Disconnect
              </button>
            </div>
          ) : (
            <button className="btn-primary" onClick={connectWallet}>
              Connect Wallet
            </button>
          )}
        </div>
      </nav>

      <main className="main-content">
        <header className="hero">
          <h1>Campus Lost &amp; Found Ledger</h1>
          <p>
            Trustless &amp; decentralized &mdash; no admin, no middleman.
            Every report, claim, and return is validated automatically by
            the smart contract.
            <br />
            Contract:{" "}
            <span className="contract-addr">{truncateAddress(CONTRACT_ADDRESS)}</span>
          </p>
        </header>

        {!account ? (
          <div className="login-prompt glass-card">
            <h2>Welcome to BlockFind</h2>
            <p className="card-subtitle">
              Connect your MetaMask wallet to report found items, prove
              ownership of lost belongings, and track every item on an
              immutable ledger. No central authority required.
            </p>
            <button className="btn-primary btn-lg" onClick={connectWallet}>
              Connect Wallet to Continue
            </button>
          </div>

        ) : hasError ? (
          <div className="login-prompt glass-card">
            <h2>Connection Issue</h2>
            <p className="card-subtitle">
              {networkError || "Cannot reach the smart contract."}
            </p>
            <button
              className="btn-primary btn-lg"
              onClick={async () => { const ok = await verifyNetwork(); if (ok) loadItems(); }}
            >
              Retry Connection
            </button>
          </div>

        ) : (
          <>
            {/* ---------- How it Works ---------- */}
            <section className="how-it-works">
              <div className="how-step">
                <div className="how-num">1</div>
                <div>
                  <strong>Anyone reports</strong> a found item. Secret features
                  are hashed before storage &mdash; plaintext never touches the chain.
                </div>
              </div>
              <div className="how-arrow">→</div>
              <div className="how-step">
                <div className="how-num">2</div>
                <div>
                  <strong>True owner claims</strong> by typing the features.
                  The contract hashes them on-chain and approves automatically
                  if the threshold is met.
                </div>
              </div>
              <div className="how-arrow">→</div>
              <div className="how-step">
                <div className="how-num">3</div>
                <div>
                  <strong>Finder confirms</strong> they handed the item back.
                  Only the original reporter can do this &mdash; no admin needed.
                </div>
              </div>
            </section>

            {/* ---------- Report Section ---------- */}
            <section className="dashboard">
              <div className="report-card glass-card">
                <h2>Report a Found Item</h2>
                <p className="card-subtitle">
                  Found something on campus? Register it on the blockchain.
                  You become the custody holder; only you can confirm the
                  final return.
                </p>

                <div className="input-group">
                  <label>Item Description</label>
                  <input
                    type="text"
                    className="input-field"
                    placeholder='e.g., "Blue backpack found near Library B"'
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Secret Identifying Features</label>
                  <input
                    type="text"
                    className="input-field"
                    placeholder="e.g., torn zipper, red keychain, math notebook"
                    value={features}
                    onChange={(e) => setFeatures(e.target.value)}
                  />
                  <small>
                    Comma-separated features only the true owner would know.
                    These are hashed with keccak256 before submission &mdash;
                    plaintext is never stored on-chain.
                  </small>
                </div>

                <div className="input-group">
                  <label>Match Threshold</label>
                  <input
                    type="number"
                    className="input-field"
                    placeholder="Minimum features that must match to approve a claim"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    min="1"
                  />
                </div>

                <button className="btn-primary btn-full" onClick={reportItem}>
                  Submit Report to Blockchain
                </button>
              </div>
            </section>

            {/* ---------- Items Section ---------- */}
            <section className="items-section">
              <div className="items-header">
                <h2>Ledger ({items.length} items)</h2>
                <button
                  className="btn-secondary"
                  onClick={loadItems}
                  disabled={loading}
                >
                  {loading ? "Loading..." : "Refresh"}
                </button>
              </div>

              <div className="filter-tabs">
                <button
                  className={`filter-tab${filter === "all" ? " active" : ""}`}
                  onClick={() => setFilter("all")}
                >
                  All ({items.length})
                </button>
                {STATUS_LABELS.map((label, i) => (
                  <button
                    key={i}
                    className={`filter-tab${filter === String(i) ? " active" : ""}`}
                    onClick={() => setFilter(String(i))}
                  >
                    {label} ({statusCounts[i] || 0})
                  </button>
                ))}
              </div>

              <div className="items-grid">
                {filteredItems.length === 0 ? (
                  <div className="no-items">
                    {items.length === 0
                      ? "No items recorded on the ledger yet."
                      : "No items match this filter."}
                  </div>
                ) : (
                  filteredItems.map((item) => {
                    const idKey = normalizeItemId(item.itemId);
                    const st = itemStatus(item);
                    const isReporter =
                      account &&
                      item.reporter.toLowerCase() === account.toLowerCase();
                    const busy = pendingIds.has(idKey);

                    return (
                      <div key={idKey} className="item-card glass-card">
                        <div className="item-header">
                          <span className="item-id" title={idKey}>
                            {truncateId(idKey)}
                          </span>
                          <span className={`status-badge status-${st}`}>
                            {STATUS_LABELS[st] ?? "?"}
                          </span>
                        </div>

                        <p className="item-description">{item.description}</p>

                        <div className="item-details">
                          <div className="detail-row">
                            <span className="detail-label">Finder (Reporter)</span>
                            <span className="detail-value address" title={item.reporter}>
                              {truncateAddress(item.reporter)}
                              {isReporter && (
                                <span className="you-badge">you</span>
                              )}
                            </span>
                          </div>
                          {item.claimant && item.claimant !== ethers.ZeroAddress && (
                            <div className="detail-row">
                              <span className="detail-label">Verified Owner</span>
                              <span className="detail-value address" title={item.claimant}>
                                {truncateAddress(item.claimant)}
                              </span>
                            </div>
                          )}
                          <div className="detail-row">
                            <span className="detail-label">Claim Threshold</span>
                            <span className="detail-value">
                              {item.threshold} of {item.featureCount} features
                            </span>
                          </div>
                        </div>

                        <StatusTimeline item={item} />

                        <div className="item-actions">

                          {/* ── State 0: Reported ── */}
                          {st === 0 && (() => {
                            if (isReporter) {
                              // Reporter sees: lock notice + full claimant list with per-person reopen
                              return (
                                <div className="action-group">
                                  <div className="action-info">
                                    You reported this item — you cannot claim it yourself.
                                  </div>
                                  {item.claimants.length === 0 ? (
                                    <div className="action-info" style={{fontSize:"0.78rem"}}>
                                      No one has attempted to claim this item yet.
                                    </div>
                                  ) : (
                                    <div className="claimant-list">
                                      <div className="claimant-list-header">
                                        Claim Attempts ({item.claimants.length})
                                      </div>
                                      {item.claimants.map((c) => {
                                        const rowKey = `${idKey}-${c.address}`;
                                        const rowBusy = pendingIds.has(rowKey);
                                        const canReopen = c.blocked && c.reopensRemaining > 0;
                                        return (
                                          <div key={c.address} className="claimant-row">
                                            <div className="claimant-addr" title={c.address}>
                                              {truncateAddress(c.address)}
                                            </div>
                                            <div className="claimant-stats">
                                              <span className="claimant-fails">
                                                {c.failedAttempts} false {c.failedAttempts === 1 ? "attempt" : "attempts"}
                                              </span>
                                              <span className={`claimant-status ${c.blocked ? "status-blocked" : "status-open"}`}>
                                                {c.blocked ? "blocked" : "open"}
                                              </span>
                                              {c.reopensUsed > 0 && (
                                                <span className="claimant-reopens">
                                                  {c.reopensUsed} reopen{c.reopensUsed > 1 ? "s" : ""} used
                                                </span>
                                              )}
                                            </div>
                                            {canReopen ? (
                                              <button
                                                className="btn-reopen"
                                                onClick={() => reopenForClaimant(idKey, c.address)}
                                                disabled={rowBusy}
                                                title={`${c.reopensRemaining} reopen${c.reopensRemaining === 1 ? "" : "s"} remaining`}
                                              >
                                                {rowBusy ? "..." : `Reopen (${c.reopensRemaining} left)`}
                                              </button>
                                            ) : c.blocked && c.reopensRemaining === 0 ? (
                                              <span className="claimant-maxed">Max reopens reached</span>
                                            ) : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            }

                            if (item.blocked) {
                              // Claimant already used their attempt
                              return (
                                <div className="action-info">
                                  You already submitted a claim. Wait for the reporter
                                  to reopen your attempt if you believe you are the owner.
                                </div>
                              );
                            }

                            // Normal claim form
                            return (
                              <div className="action-group">
                                <input
                                  type="text"
                                  className="input-field-small"
                                  placeholder="Exact features you know (comma-separated)"
                                  value={claimFeatures[idKey] || ""}
                                  onChange={(e) =>
                                    setClaimFeatures((prev) => ({
                                      ...prev,
                                      [idKey]: e.target.value,
                                    }))
                                  }
                                  disabled={busy}
                                />
                                <button
                                  className="btn-action btn-claim"
                                  onClick={() => claimItem(idKey)}
                                  disabled={busy}
                                >
                                  {busy ? "Submitting..." : "Submit Ownership Claim"}
                                </button>
                              </div>
                            );
                          })()}

                          {/* ── State 1: Claimed — reporter initiates handoff ── */}
                          {st === 1 && isReporter && (
                            <button
                              className="btn-action btn-return"
                              onClick={() => confirmHandoff(idKey)}
                              disabled={busy}
                            >
                              {busy ? "Confirming..." : "Confirm Physical Handoff"}
                            </button>
                          )}
                          {st === 1 && !isReporter && account &&
                            item.claimant.toLowerCase() === account.toLowerCase() && (
                            <div className="action-info">
                              Ownership verified &mdash; waiting for finder
                              ({truncateAddress(item.reporter)}) to confirm handoff.
                            </div>
                          )}
                          {st === 1 && !isReporter && account &&
                            item.claimant.toLowerCase() !== account.toLowerCase() && (
                            <div className="action-info">
                              Ownership verified &mdash; handoff in progress.
                            </div>
                          )}

                          {/* ── State 2: HandoffPending — claimant confirms receipt ── */}
                          {st === 2 && (() => {
                            const hi = item.handoffInfo;
                            const isClaimant = account &&
                              item.claimant.toLowerCase() === account.toLowerCase();
                            const myPendingCancel = hi.hasPendingCancel &&
                              hi.cancelRequester.toLowerCase() === account?.toLowerCase();
                            const theirPendingCancel = hi.hasPendingCancel &&
                              hi.cancelRequester.toLowerCase() !== account?.toLowerCase();

                            return (
                              <div className="action-group">
                                {/* Step 2 button — only claimant can confirm receipt */}
                                {isClaimant && !hi.hasPendingCancel && (
                                  <button
                                    className="btn-action btn-return"
                                    onClick={() => confirmReceipt(idKey)}
                                    disabled={busy}
                                  >
                                    {busy ? "Confirming..." : "Confirm I Received the Item"}
                                  </button>
                                )}
                                {isReporter && !hi.hasPendingCancel && (
                                  <div className="action-info">
                                    You confirmed handoff &mdash; waiting for{" "}
                                    {truncateAddress(item.claimant)} to confirm receipt.
                                  </div>
                                )}

                                {/* Cancel system */}
                                {!hi.hasPendingCancel && (
                                  <button
                                    className="btn-action btn-secondary"
                                    onClick={() => requestCancelHandoff(idKey)}
                                    disabled={busy}
                                    title="Request mutual cancellation — other party must approve"
                                  >
                                    {busy ? "..." : "Request Cancellation"}
                                  </button>
                                )}
                                {myPendingCancel && (
                                  <div className="action-info" style={{color:"var(--warning)"}}>
                                    You requested cancellation on{" "}
                                    {formatTimestamp(hi.cancelRequestedAt)}.
                                    Waiting for the other party to approve.
                                  </div>
                                )}
                                {theirPendingCancel && (
                                  <div className="action-group">
                                    <div className="action-info" style={{color:"var(--warning)"}}>
                                      {truncateAddress(hi.cancelRequester)} requested cancellation on{" "}
                                      {formatTimestamp(hi.cancelRequestedAt)}.
                                    </div>
                                    <button
                                      className="btn-action btn-found"
                                      onClick={() => approveCancelHandoff(idKey)}
                                      disabled={busy}
                                    >
                                      {busy ? "..." : "Approve Cancellation"}
                                    </button>
                                  </div>
                                )}

                                {/* Cancel audit trail */}
                                {hi.totalCancels > 0 && (
                                  <div className="cancel-audit">
                                    <div className="cancel-audit-header">
                                      Cancellation History ({hi.totalCancels})
                                    </div>
                                    {hi.cancelRecords.map((rec, idx) => (
                                      <div key={idx} className="cancel-record">
                                        <span className="cancel-label">Requested by</span>
                                        <span className="cancel-addr">{truncateAddress(rec.requester)}</span>
                                        <span className="cancel-time">{formatTimestamp(rec.requestedAt)}</span>
                                        {rec.approved ? (
                                          <>
                                            <span className="cancel-label">Approved by</span>
                                            <span className="cancel-addr">{truncateAddress(rec.approver)}</span>
                                            <span className="cancel-time">{formatTimestamp(rec.approvedAt)}</span>
                                          </>
                                        ) : (
                                          <span className="cancel-open">Open / Ignored</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* ── State 3: Returned — complete ── */}
                          {st === 3 && (
                            <div className="action-group">
                              <div className="action-info action-complete">
                                Item successfully returned to verified owner.
                              </div>
                              {/* Show cancel history if any occurred */}
                              {item.handoffInfo.totalCancels > 0 && (
                                <div className="cancel-audit">
                                  <div className="cancel-audit-header">
                                    Cancellation History ({item.handoffInfo.totalCancels} on record)
                                  </div>
                                  {item.handoffInfo.cancelRecords.map((rec, idx) => (
                                    <div key={idx} className="cancel-record">
                                      <span className="cancel-label">Requested by</span>
                                      <span className="cancel-addr">{truncateAddress(rec.requester)}</span>
                                      <span className="cancel-time">{formatTimestamp(rec.requestedAt)}</span>
                                      {rec.approved ? (
                                        <>
                                          <span className="cancel-label">Approved by</span>
                                          <span className="cancel-addr">{truncateAddress(rec.approver)}</span>
                                        </>
                                      ) : (
                                        <span className="cancel-open">Ignored (never approved)</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>
          No admin &middot; No middleman &middot; Powered by Ethereum Proof of
          Stake &middot; All transactions are immutable and tamper-proof
        </p>
      </footer>
    </div>
  );
}

export default App;
