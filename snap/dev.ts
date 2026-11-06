// Everything MetaMask Flask needs for the Winterlock Snap, in one terminal: builds the pipeline core the Snap imports,
// then runs the local bundler (127.0.0.1:15192), the Snap (built, served on localhost:15191) and its page
// (http://localhost:15190). Ctrl-C stops all three; if one exits, the others stop too.
//   cd snap && bun run dev
// Written with Claude Code (AI).
const ROOT = new URL("..", import.meta.url).pathname;

const core = Bun.spawnSync(["bun", "scripts/build-core.ts"], { cwd: `${ROOT}pipeline`, stdout: "inherit", stderr: "inherit" });
if (core.exitCode !== 0) process.exit(core.exitCode ?? 1);

const services = [
  { name: "bundler", cwd: `${ROOT}bundler`, cmd: ["bun", "src/main.ts"] },
  { name: "snap", cwd: `${ROOT}snap`, cmd: ["sh", "-c", "bunx mm-snap build && bunx mm-snap serve"] },
  { name: "page", cwd: `${ROOT}snap`, cmd: ["bun", "site/serve.ts"] },
];

async function prefix(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) console.log(`[${name.padEnd(7)}] ${line}`);
  }
  if (buffered) console.log(`[${name.padEnd(7)}] ${buffered}`);
}

const children = services.map(({ name, cwd, cmd }) => {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  prefix(name, child.stdout);
  prefix(name, child.stderr);
  child.exited.then((code) => {
    console.log(`[${name.padEnd(7)}] exited with code ${code}; stopping the others`);
    stop(code || 1);
  });
  return child;
});

function stop(code: number) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
console.log("Open http://localhost:15190 in the browser with MetaMask Flask.");
