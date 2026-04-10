"use client";

import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, formatUnits, parseUnits } from "ethers";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Xu3o8Icon } from "@/components/Xu3o8Icon";
import {
  ADDRESSES,
  erc20Abi,
  FULL_RANGE_TICK_LOWER,
  FULL_RANGE_TICK_UPPER,
  POOL_FEE,
  poolAbi,
  positionManagerAbi,
  quoterAbi,
  swapRouterAbi,
  TOKENS,
  TXPARK_CHAIN_ID,
  TXPARK_HEX_CHAIN_ID,
  TXPARK_RPC_URL,
  type TokenKey,
  type WriteAction,
} from "@/lib/txpark";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type WalletState = {
  account: string | null;
  chainId: number | null;
  isCorrectNetwork: boolean;
};

type PoolState = {
  usdcPerXu3o8: number | null;
  xu3o8PerUsdc: number | null;
  liquidity: string | null;
};

type QuoteState = {
  amountOut: string | null;
  error: string | null;
};

const publicProvider = new JsonRpcProvider(TXPARK_RPC_URL, TXPARK_CHAIN_ID);
const tokenOrder = [TOKENS.usdc, TOKENS.xu3o8] as const;
const tokenSwapPillClassName = "bg-white text-black";

function getEthereumProvider() {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as Window & { ethereum?: EthereumProvider }).ethereum ?? null;
}

function shortenAddress(value: string | null) {
  if (!value) return "Not connected";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** Human-readable chain name for known networks; otherwise numeric chain id. */
function getConnectedChainDisplayName(chainId: number | null) {
  if (chainId === null) return "Unknown";
  if (chainId === TXPARK_CHAIN_ID) return "Tezos X EVM Testnet";
  return `Chain ${chainId}`;
}

function formatBalance(value: bigint | null, decimals: number, fractionDigits = 4) {
  if (value === null) return "0";
  const formatted = Number(formatUnits(value, decimals));
  if (!Number.isFinite(formatted)) return "0";
  return formatted.toLocaleString(undefined, {
    maximumFractionDigits: fractionDigits,
  });
}

function parseInputAmount(value: string, decimals: number) {
  if (!value || Number(value) <= 0) return null;
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
}

function getTokenPriceFromSqrtPrice(sqrtPriceX96: bigint) {
  const q192 = 2n ** 192n;
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  const rawRatioScaled = Number((ratioX192 * 1_000_000_000_000n) / q192) / 1_000_000_000_000;
  const xu3o8PerUsdc = rawRatioScaled * 10 ** (TOKENS.usdc.decimals - TOKENS.xu3o8.decimals);
  if (!Number.isFinite(xu3o8PerUsdc) || xu3o8PerUsdc <= 0) {
    return { xu3o8PerUsdc: null, usdcPerXu3o8: null };
  }
  return {
    xu3o8PerUsdc,
    usdcPerXu3o8: 1 / xu3o8PerUsdc,
  };
}

function getReadableErrorMessage(error: unknown) {
  if (!error) {
    return "Something went wrong. Please try again.";
  }

  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message)
      : "";

  if (code === "4001" || code === "ACTION_REJECTED" || /user denied|user rejected|rejected/i.test(message)) {
    return "Transaction cancelled in wallet.";
  }

  if (/insufficient funds/i.test(message)) {
    return "Insufficient funds for this transaction.";
  }

  if (/wallet not available/i.test(message)) {
    return "No wallet detected. Open the app in MetaMask or another injected wallet.";
  }

  if (/network switch failed/i.test(message)) {
    return "Could not switch to Tezos X EVM testnet. Please change network in your wallet.";
  }

  if (/missing required env/i.test(message)) {
    return "App configuration is incomplete.";
  }

  return message || "Something went wrong. Please try again.";
}

async function readPoolState() {
  const pool = new Contract(ADDRESSES.pool, poolAbi, publicProvider);
  const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const price = getTokenPriceFromSqrtPrice(slot0.sqrtPriceX96 as bigint);

  return {
    usdcPerXu3o8: price.usdcPerXu3o8,
    xu3o8PerUsdc: price.xu3o8PerUsdc,
    liquidity: liquidity.toString(),
  } satisfies PoolState;
}

async function readBalances(account: string) {
  const usdc = new Contract(TOKENS.usdc.address, erc20Abi, publicProvider);
  const xu3o8 = new Contract(TOKENS.xu3o8.address, erc20Abi, publicProvider);
  const [usdcBalance, xu3o8Balance] = await Promise.all([usdc.balanceOf(account), xu3o8.balanceOf(account)]);
  return {
    usdc: usdcBalance as bigint,
    xu3o8: xu3o8Balance as bigint,
  };
}

async function readAllowance(account: string, tokenKey: TokenKey, spender: string) {
  const token = new Contract(TOKENS[tokenKey].address, erc20Abi, publicProvider);
  const allowance = await token.allowance(account, spender);
  return allowance as bigint;
}

async function quoteSwap(tokenInKey: TokenKey, amountIn: bigint) {
  const quoter = new Contract(ADDRESSES.quoterV2, quoterAbi, publicProvider);
  const tokenIn = TOKENS[tokenInKey];
  const tokenOut = tokenInKey === "usdc" ? TOKENS.xu3o8 : TOKENS.usdc;

  const result = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    fee: POOL_FEE,
    sqrtPriceLimitX96: 0,
  });

  return result.amountOut as bigint;
}

export default function Home() {
  const [activeView, setActiveView] = useState<"swap" | "wallet" | "pool" | "liquidity">("swap");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [wallet, setWallet] = useState<WalletState>({
    account: null,
    chainId: null,
    isCorrectNetwork: false,
  });
  const [balances, setBalances] = useState<{ usdc: bigint | null; xu3o8: bigint | null }>({
    usdc: null,
    xu3o8: null,
  });
  const [poolState, setPoolState] = useState<PoolState>({
    usdcPerXu3o8: null,
    xu3o8PerUsdc: null,
    liquidity: null,
  });
  const [quote, setQuote] = useState<QuoteState>({ amountOut: null, error: null });
  const [swapFrom, setSwapFrom] = useState<TokenKey>("usdc");
  const [swapAmount, setSwapAmount] = useState("100");
  const [liquidityUsdc, setLiquidityUsdc] = useState("100");
  const [liquidityXu3o8, setLiquidityXu3o8] = useState("20");
  const [pendingAction, setPendingAction] = useState<WriteAction | null>(null);
  const [swapAllowance, setSwapAllowance] = useState<bigint>(0n);
  const [liquidityAllowances, setLiquidityAllowances] = useState({ usdc: 0n, xu3o8: 0n });

  const swapTo = swapFrom === "usdc" ? "xu3o8" : "usdc";
  const swapInputParsed = parseInputAmount(swapAmount, TOKENS[swapFrom].decimals);
  const liquidityUsdcParsed = parseInputAmount(liquidityUsdc, TOKENS.usdc.decimals);
  const liquidityXu3o8Parsed = parseInputAmount(liquidityXu3o8, TOKENS.xu3o8.decimals);

  const refreshWalletState = useCallback(async () => {
    const ethereum = getEthereumProvider();
    if (!ethereum) return;

    const browserProvider = new BrowserProvider(ethereum);
    const network = await browserProvider.getNetwork();
    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    const account = accounts[0] ?? null;
    const chainId = Number(network.chainId);

    setWallet({
      account,
      chainId,
      isCorrectNetwork: chainId === TXPARK_CHAIN_ID,
    });
  }, []);

  const refreshReadState = useCallback(async (account?: string | null) => {
    const [nextPoolState, nextBalances] = await Promise.all([
      readPoolState(),
      account ? readBalances(account) : Promise.resolve({ usdc: null, xu3o8: null }),
    ]);

    setPoolState(nextPoolState);
    setBalances(nextBalances);

    if (account) {
      const [nextSwapAllowance, nextUsdcLiquidityAllowance, nextXu3o8LiquidityAllowance] = await Promise.all([
        readAllowance(account, swapFrom, ADDRESSES.swapRouter),
        readAllowance(account, "usdc", ADDRESSES.positionManager),
        readAllowance(account, "xu3o8", ADDRESSES.positionManager),
      ]);

      setSwapAllowance(nextSwapAllowance);
      setLiquidityAllowances({
        usdc: nextUsdcLiquidityAllowance,
        xu3o8: nextXu3o8LiquidityAllowance,
      });
    }
  }, [swapFrom]);

  async function connectWallet() {
    const ethereum = getEthereumProvider();
    if (!ethereum) {
      toast.error("No wallet detected. Open the app in MetaMask or Rabby.");
      return;
    }

    try {
      await ethereum.request({ method: "eth_requestAccounts" });
      await refreshWalletState();
      setAccountMenuOpen(false);
      toast.success("Wallet connected");
    } catch (error) {
      toast.error(getReadableErrorMessage(error));
    }
  }

  function disconnectWallet() {
    setWallet({
      account: null,
      chainId: null,
      isCorrectNetwork: false,
    });
    setBalances({ usdc: null, xu3o8: null });
    setSwapAllowance(0n);
    setLiquidityAllowances({ usdc: 0n, xu3o8: 0n });
    setAccountMenuOpen(false);
    toast.success("Wallet disconnected");
  }

  async function switchToParkSwap() {
    const ethereum = getEthereumProvider();
    if (!ethereum) return;

    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TXPARK_HEX_CHAIN_ID }],
      });
    } catch (error) {
      try {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: TXPARK_HEX_CHAIN_ID,
              chainName: "ParkSwap",
              rpcUrls: [TXPARK_RPC_URL],
              nativeCurrency: {
                name: "TXP",
                symbol: "TXP",
                decimals: 18,
              },
            },
          ],
        });
      } catch (innerError) {
        toast.error(getReadableErrorMessage(innerError ?? error));
        return;
      }
    }

    await refreshWalletState();
    toast.success("Switched to Tezos X EVM testnet");
  }

  async function withSigner<T>(callback: (provider: BrowserProvider, account: string) => Promise<T>) {
    const ethereum = getEthereumProvider();
    if (!ethereum) throw new Error("Wallet not available");
    const browserProvider = new BrowserProvider(ethereum);
    const signer = await browserProvider.getSigner();
    const account = await signer.getAddress();
    return callback(browserProvider, account);
  }

  async function approveSwapToken() {
    if (!wallet.isCorrectNetwork) {
      toast.error("Switch to Tezos X EVM testnet before approving.");
      return;
    }

    const amount = swapInputParsed;
    if (!amount) {
      toast.error("Enter a valid swap amount first.");
      return;
    }

    setPendingAction("approve-swap");
    toast.loading(`Approving ${TOKENS[swapFrom].symbol} for swap...`, { id: "approve-swap" });

    try {
      await withSigner(async (browserProvider) => {
        const signer = await browserProvider.getSigner();
        const token = new Contract(TOKENS[swapFrom].address, erc20Abi, signer);
        const tx = await token.approve(ADDRESSES.swapRouter, MaxUint256);
        await tx.wait();
      });
      toast.success(`Approved ${TOKENS[swapFrom].symbol} for swaps`, { id: "approve-swap" });
      await refreshReadState(wallet.account);
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "approve-swap" });
    } finally {
      setPendingAction(null);
    }
  }

  async function runSwap() {
    if (!wallet.isCorrectNetwork) {
      toast.error("Switch to Tezos X EVM testnet before swapping.");
      return;
    }
    const amount = swapInputParsed;
    if (!amount) {
      toast.error("Enter a valid swap amount.");
      return;
    }

    setPendingAction("swap");
    toast.loading(`Submitting ${TOKENS[swapFrom].symbol} → ${TOKENS[swapTo].symbol} swap...`, { id: "swap" });

    try {
      await withSigner(async (browserProvider) => {
        const signer = await browserProvider.getSigner();
        const router = new Contract(ADDRESSES.swapRouter, swapRouterAbi, signer);
        const tx = await router.exactInputSingle({
          tokenIn: TOKENS[swapFrom].address,
          tokenOut: TOKENS[swapTo].address,
          fee: POOL_FEE,
          recipient: wallet.account,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          amountIn: amount,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        });
        await tx.wait();
      });
      toast.success("Swap confirmed on Tezos X EVM network", { id: "swap" });
      await refreshReadState(wallet.account);
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "swap" });
    } finally {
      setPendingAction(null);
    }
  }

  async function approveLiquidityTokens() {
    if (!wallet.isCorrectNetwork) {
      toast.error("Switch to Tezos X EVM testnet before approving liquidity.");
      return;
    }

    setPendingAction("approve-liquidity");
    toast.loading("Approving USDC and xU3O8 for liquidity...", { id: "approve-liquidity" });

    try {
      await withSigner(async (browserProvider) => {
        const signer = await browserProvider.getSigner();
        const usdc = new Contract(TOKENS.usdc.address, erc20Abi, signer);
        const xu3o8 = new Contract(TOKENS.xu3o8.address, erc20Abi, signer);
        const tx1 = await usdc.approve(ADDRESSES.positionManager, MaxUint256);
        await tx1.wait();
        const tx2 = await xu3o8.approve(ADDRESSES.positionManager, MaxUint256);
        await tx2.wait();
      });
      toast.success("Liquidity approvals confirmed", { id: "approve-liquidity" });
      await refreshReadState(wallet.account);
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "approve-liquidity" });
    } finally {
      setPendingAction(null);
    }
  }

  async function addLiquidity() {
    if (!wallet.isCorrectNetwork) {
      toast.error("Switch to Tezos X EVM testnet before adding liquidity.");
      return;
    }
    if (!liquidityUsdcParsed || !liquidityXu3o8Parsed) {
      toast.error("Enter valid liquidity amounts.");
      return;
    }

    setPendingAction("liquidity");
    toast.loading("Minting a new full-range liquidity position...", { id: "liquidity" });

    try {
      await withSigner(async (browserProvider) => {
        const signer = await browserProvider.getSigner();
        const positionManager = new Contract(ADDRESSES.positionManager, positionManagerAbi, signer);
        const tx = await positionManager.mint({
          token0: TOKENS.usdc.address,
          token1: TOKENS.xu3o8.address,
          fee: POOL_FEE,
          tickLower: FULL_RANGE_TICK_LOWER,
          tickUpper: FULL_RANGE_TICK_UPPER,
          amount0Desired: liquidityUsdcParsed,
          amount1Desired: liquidityXu3o8Parsed,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.account,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });
        await tx.wait();
      });
      toast.success("Liquidity position minted", { id: "liquidity" });
      await refreshReadState(wallet.account);
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "liquidity" });
    } finally {
      setPendingAction(null);
    }
  }

  useEffect(() => {
    refreshWalletState().catch(() => undefined);
    refreshReadState(null).catch(() => undefined);

    const ethereum = getEthereumProvider();
    if (!ethereum?.on) return;

    const handleAccountsChanged = () => {
      refreshWalletState().catch(() => undefined);
    };
    const handleChainChanged = () => {
      refreshWalletState().catch(() => undefined);
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
      ethereum.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [refreshReadState, refreshWalletState]);

  useEffect(() => {
    if (!wallet.account) {
      setBalances({ usdc: null, xu3o8: null });
      setAccountMenuOpen(false);
      return;
    }

    refreshReadState(wallet.account).catch((error) => {
      toast.error(getReadableErrorMessage(error));
    });
  }, [refreshReadState, wallet.account, wallet.chainId, swapFrom]);

  useEffect(() => {
    if (!accountMenuOpen && !moreMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountMenuOpen && accountMenuRef.current && !accountMenuRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [accountMenuOpen, moreMenuOpen]);

  useEffect(() => {
    if (!swapInputParsed) {
      setQuote({ amountOut: null, error: null });
      return;
    }

    let cancelled = false;
    quoteSwap(swapFrom, swapInputParsed)
      .then((amountOut) => {
        if (cancelled) return;
        setQuote({
          amountOut: formatUnits(amountOut, TOKENS[swapTo].decimals),
          error: null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setQuote({
          amountOut: null,
          error: "Quote unavailable right now",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [swapFrom, swapTo, swapInputParsed]);

  const needsSwapApproval = swapInputParsed ? swapAllowance < swapInputParsed : true;
  const needsLiquidityApproval =
    !liquidityUsdcParsed ||
    !liquidityXu3o8Parsed ||
    liquidityAllowances.usdc < liquidityUsdcParsed ||
    liquidityAllowances.xu3o8 < liquidityXu3o8Parsed;

  return (
    <main className="min-h-screen bg-[#131313] text-white">
      <div className="border-b border-white/8 bg-[#171717]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-3 text-sm text-white/70">
          <p className="truncate">This interface is a lightweight MVP for USDC/xU3O8 on Tezos X testnet.</p>
          <a
            href="https://demo.txpark.nomadic-labs.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-white hover:text-white/75"
          >
            Read more
          </a>
        </div>
      </div>

      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col px-5 py-4">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
              ◈
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <p className="text-3xl font-semibold tracking-tight text-white">ParkSwap</p>
                <span className="text-white/55">▾</span>
              </div>
              <nav className="flex flex-wrap gap-2 text-sm text-white/65">
                {[
                  { key: "swap", label: "Trade" },
                  { key: "wallet", label: "Wallet" },
                  { key: "pool", label: "Pool" },
                  { key: "liquidity", label: "Liquidity" },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setActiveView(item.key as typeof activeView)}
                    className={`rounded-full px-3 py-2 ${
                      activeView === item.key ? "text-white" : "text-white/65 hover:text-white"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div ref={moreMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreMenuOpen((open) => !open)}
                className={`rounded-full p-2 text-xl text-white/65 hover:bg-white/6 hover:text-white ${moreMenuOpen ? "bg-white/8 text-white" : ""}`}
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                aria-label="App menu"
              >
                ⋯
              </button>
              {moreMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-30 mt-2 w-[min(100vw-2rem,320px)] rounded-2xl border border-white/10 bg-[#1b1b1b] p-3 shadow-2xl"
                >
                  <p className="px-2 pb-2 text-xs font-medium text-white/45">Session</p>
                  <div className="space-y-3 rounded-xl border border-white/8 bg-[#202020] p-3 text-sm text-white/75">
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-white/55">Connected account</span>
                      <span className="break-all text-right font-mono text-xs text-white/85">{shortenAddress(wallet.account)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-white/55">Network</span>
                      <span className="text-right text-xs text-white/85">
                        {wallet.account ? getConnectedChainDisplayName(wallet.chainId) : "Not connected"}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-white/55">Position manager</span>
                      <span className="break-all text-right font-mono text-xs text-white/85">{shortenAddress(ADDRESSES.positionManager)}</span>
                    </div>
                    <p className="border-t border-white/8 pt-3 text-xs leading-relaxed text-white/55">
                      Pool fees are stored in the pool contract; the fee tier is fixed when the pool is created.
                    </p>
                  </div>
                </div>
              )}
            </div>
            {wallet.account ? (
              <div ref={accountMenuRef} className="relative">
                <button
                  type="button"
                  onClick={wallet.isCorrectNetwork ? () => setAccountMenuOpen((open) => !open) : switchToParkSwap}
                  className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85"
                >
                  {wallet.isCorrectNetwork ? shortenAddress(wallet.account) : "Switch to ParkSwap"}
                </button>
                {wallet.isCorrectNetwork && accountMenuOpen && (
                  <div className="absolute right-0 z-30 mt-2 min-w-[220px] rounded-2xl border border-white/10 bg-[#1b1b1b] p-2 shadow-2xl">
                    <div className="rounded-xl px-3 py-2 text-xs text-white/45">Connected account</div>
                    <div className="rounded-xl px-3 py-2 font-mono text-xs text-white/80">
                      {wallet.account}
                    </div>
                    <button
                      type="button"
                      onClick={disconnectWallet}
                      className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-red-400 hover:bg-red-500/15 hover:text-red-300"
                    >
                      Disconnect wallet
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={connectWallet}
                className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85"
              >
                Connect wallet
              </button>
            )}
          </div>
        </header>

        <section className="flex-1">
          <div className="flex min-h-[720px] items-start justify-center pt-6">
            {activeView === "swap" && (
              <div className="w-full max-w-[500px]">
                <div className="mb-3 flex items-center justify-between px-2">
                  <div className="flex items-center gap-2 rounded-full bg-[#232323] p-1 text-sm">
                    {["Swap", "Limit", "Buy", "Sell"].map((label, index) => (
                      <button
                        key={label}
                        type="button"
                        className={`rounded-full px-4 py-2 ${index === 0 ? "bg-[#3a3a3a] text-white" : "text-white/55"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="rounded-full p-2 text-xl text-white/70 hover:bg-white/6">
                    ⚙
                  </button>
                </div>

                <div className="rounded-[30px] bg-[#191919] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
                  <div className="rounded-[24px] border border-white/10 bg-[#151515] p-5">
                    <div className="mb-3 flex items-center justify-between text-sm text-white/55">
                      <span>Sell</span>
                      <span>{wallet.account ? formatBalance(balances[swapFrom], TOKENS[swapFrom].decimals) : "0"}</span>
                    </div>
                    <div className="flex items-end justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <input
                          value={swapAmount}
                          onChange={(event) => setSwapAmount(event.target.value)}
                          className="w-full bg-transparent text-5xl font-medium tracking-tight outline-none placeholder:text-white/20"
                          placeholder="0.0"
                          inputMode="decimal"
                        />
                        <div className="mt-2 text-sm text-white/35">
                          {poolState.usdcPerXu3o8
                            ? `≈ ${(Number(swapAmount || 0) * (swapFrom === "usdc" ? 1 : poolState.usdcPerXu3o8)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD`
                            : "$0"}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSwapFrom(swapTo)}
                        className={`flex items-center gap-2 rounded-full ${tokenSwapPillClassName} px-4 py-2.5 text-sm font-semibold shadow-lg`}
                        aria-label={`Switch sell token from ${TOKENS[swapFrom].symbol}`}
                      >
                        {swapFrom === "xu3o8" ? <Xu3o8Icon className="h-5 w-5 shrink-0" /> : null}
                        {TOKENS[swapFrom].symbol}
                      </button>
                    </div>
                  </div>

                  <div className="relative z-10 -my-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setSwapFrom(swapTo)}
                      className="flex h-14 w-14 items-center justify-center rounded-2xl border-[6px] border-[#191919] bg-[#2a2a2a] text-2xl text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)] hover:bg-[#363636]"
                      aria-label="Flip swap direction"
                    >
                      ↓
                    </button>
                  </div>

                  <div className="rounded-[24px] bg-[#222222] p-5">
                    <div className="mb-3 flex items-center justify-between text-sm text-white/55">
                      <span>Buy</span>
                      <span>{wallet.account ? formatBalance(balances[swapTo], TOKENS[swapTo].decimals) : "0"}</span>
                    </div>
                    <div className="flex items-end justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-5xl font-medium tracking-tight text-white/90">
                          {quote.amountOut ? Number(quote.amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "0.0"}
                        </div>
                        <div className="mt-2 text-sm text-white/35">
                          ≈ {quote.amountOut ? Number(quote.amountOut).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSwapFrom(swapTo)}
                        className={`flex items-center gap-2 rounded-full ${tokenSwapPillClassName} px-4 py-2.5 text-sm font-semibold shadow-lg`}
                        aria-label={`Switch buy token to ${TOKENS[swapTo].symbol}`}
                      >
                        {swapTo === "xu3o8" ? <Xu3o8Icon className="h-5 w-5 shrink-0" /> : null}
                        {TOKENS[swapTo].symbol}
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 rounded-[22px] bg-[#151515] px-4 py-3 text-sm text-white/60">
                    <div className="flex items-center justify-between">
                      <span>Pool fee</span>
                      <span>0.25%</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>Pool price</span>
                      <span>
                        {poolState.usdcPerXu3o8
                          ? `${poolState.usdcPerXu3o8.toFixed(4)} USDC / ${TOKENS.xu3o8.symbol}`
                          : "Loading"}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>Quote</span>
                      <span>{quote.amountOut ? `${Number(quote.amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${TOKENS[swapTo].symbol}` : quote.error ?? "--"}</span>
                    </div>
                  </div>

                  {needsSwapApproval && (
                    <button
                      type="button"
                      onClick={approveSwapToken}
                      disabled={!wallet.account || !wallet.isCorrectNetwork || !needsSwapApproval || pendingAction !== null}
                      className="mt-3 w-full rounded-[22px] bg-[#2b2b2b] px-4 py-4 text-base font-semibold text-white enabled:hover:bg-[#363636] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {pendingAction === "approve-swap" ? "Approving..." : `Approve ${TOKENS[swapFrom].symbol}`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={runSwap}
                    disabled={!wallet.account || !wallet.isCorrectNetwork || needsSwapApproval || !swapInputParsed || pendingAction !== null}
                    className="mt-3 w-full rounded-[22px] bg-white px-4 py-4 text-base font-semibold text-black enabled:hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {wallet.account
                      ? pendingAction === "swap"
                        ? "Swapping..."
                        : `Swap ${TOKENS[swapFrom].symbol} for ${TOKENS[swapTo].symbol}`
                      : "Connect wallet"}
                  </button>
                </div>
              </div>
            )}

            {activeView === "wallet" && (
              <div className="w-full max-w-[500px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Wallet</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Balances</h3>

                <div className="mt-5 space-y-3">
                  {tokenOrder.map((token) => (
                    <div key={token.symbol} className="rounded-[24px] border border-white/10 bg-black/25 p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex min-w-0 items-center gap-3">
                          {token.key === "xu3o8" ? <Xu3o8Icon className="h-10 w-10 shrink-0" /> : null}
                          <div className="min-w-0">
                            <p className="text-base font-semibold">{token.symbol}</p>
                            <p className="text-sm text-white/45">{token.name}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-base font-semibold">
                            {wallet.account ? formatBalance(balances[token.key], token.decimals) : "0"}
                          </p>
                          <p className="text-sm text-white/45">{wallet.account ? "Wallet balance" : "Connect to load"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeView === "pool" && (
              <div className="w-full max-w-[500px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Pool</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Live pair metrics</h3>

                <div className="mt-5 grid gap-3">
                  <div className="rounded-[24px] bg-black/20 p-4">
                    <p className="text-sm text-white/45">USDC per {TOKENS.xu3o8.symbol}</p>
                    <p className="mt-2 text-3xl font-semibold">
                      {poolState.usdcPerXu3o8 ? poolState.usdcPerXu3o8.toFixed(4) : "--"}
                    </p>
                  </div>
                  <div className="rounded-[24px] bg-black/20 p-4">
                    <p className="text-sm text-white/45">{TOKENS.xu3o8.symbol} per USDC</p>
                    <p className="mt-2 text-3xl font-semibold">
                      {poolState.xu3o8PerUsdc ? poolState.xu3o8PerUsdc.toFixed(6) : "--"}
                    </p>
                  </div>
                  <div className="rounded-[24px] bg-black/20 p-4">
                    <p className="text-sm text-white/45">Pool address</p>
                    <p className="mt-2 text-lg font-semibold break-all text-white/85">{ADDRESSES.pool}</p>
                  </div>
                </div>
              </div>
            )}

            {activeView === "liquidity" && (
              <div className="w-full max-w-[500px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Liquidity</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Add to the pool</h3>

                <div className="mt-4 grid gap-3">
                  <label className="rounded-[24px] border border-white/10 bg-black/25 p-4">
                    <span className="mb-2 block text-sm text-white/55">USDC amount</span>
                    <input
                      value={liquidityUsdc}
                      onChange={(event) => setLiquidityUsdc(event.target.value)}
                      className="w-full bg-transparent text-3xl font-semibold outline-none"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="rounded-[24px] border border-white/10 bg-black/25 p-4">
                    <span className="mb-2 block text-sm text-white/55">{TOKENS.xu3o8.symbol} amount</span>
                    <input
                      value={liquidityXu3o8}
                      onChange={(event) => setLiquidityXu3o8(event.target.value)}
                      className="w-full bg-transparent text-3xl font-semibold outline-none"
                      inputMode="decimal"
                    />
                  </label>
                </div>

                <div className="mt-4 grid gap-3">
                  <button
                    type="button"
                    onClick={approveLiquidityTokens}
                    disabled={!wallet.account || !wallet.isCorrectNetwork || !needsLiquidityApproval || pendingAction !== null}
                    className="rounded-full bg-white/10 px-4 py-4 text-sm font-medium text-white enabled:hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pendingAction === "approve-liquidity" ? "Approving..." : needsLiquidityApproval ? "Approve for liquidity" : "Liquidity approved"}
                  </button>
                  <button
                    type="button"
                    onClick={addLiquidity}
                    disabled={!wallet.account || !wallet.isCorrectNetwork || needsLiquidityApproval || pendingAction !== null}
                    className="rounded-full bg-white px-4 py-4 text-sm font-semibold text-slate-950 enabled:hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pendingAction === "liquidity" ? "Adding liquidity..." : "Add liquidity"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
