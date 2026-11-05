import { RpcError, rpc as libRpc } from "@forshtat/hegota-support/rpc";
import { StepError } from "./output.js";

/** @forshtat/hegota-support' `rpc`, with failures turned into `StepError`s that carry this workshop's hints. */
export async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  try {
    return await libRpc(url, method, params);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    throw new StepError(e.code, e.message, { hint: hintFor(e) });
  }
}

function hintFor(e: RpcError): string | undefined {
  switch (e.code) {
    case "RPC_UNREACHABLE":
      return "check your network, or whether the devnet was reset or is down (see README)";
    case "RPC_BAD_RESPONSE":
      return "the devnet may be restarting";
    case "RPC_-32601":
      return `${e.url} does not implement ${e.method}; check gatewayUrl in workshop.config.json5`;
    default:
      return undefined;
  }
}
