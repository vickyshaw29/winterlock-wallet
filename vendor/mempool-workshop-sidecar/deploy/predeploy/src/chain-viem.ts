import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainPort, Hex } from "./types";

/** Real chain access through viem, sending legacy transactions signed by `privateKey`. */
export async function createViemChain(rpcUrl: string, privateKey: Hex): Promise<ChainPort> {
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: "devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return {
    chainId,
    account: account.address,
    getCode: async (address) => (await publicClient.getCode({ address })) ?? "0x",
    getBalance: (address) => publicClient.getBalance({ address }),
    transactionCount: () => publicClient.getTransactionCount({ address: account.address }),
    gasPrice: () => publicClient.getGasPrice(),
    blockGasLimit: async () => (await publicClient.getBlock()).gasLimit,
    estimateGas: (tx) =>
      publicClient.estimateGas({
        account: account.address,
        to: tx.to ?? undefined,
        data: tx.data,
        value: tx.value,
      }),
    sendAndWait: async (tx) => {
      const hash = await wallet.sendTransaction({
        type: "legacy",
        to: tx.to ?? undefined,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 1_000,
        timeout: 5 * 60_000,
      });
      return {
        hash,
        status: receipt.status,
        contractAddress: receipt.contractAddress ?? null,
        gasUsed: receipt.gasUsed,
      };
    },
    read: (address, abi, functionName, args) =>
      publicClient.readContract({ address, abi, functionName, args } as never),
  };
}
