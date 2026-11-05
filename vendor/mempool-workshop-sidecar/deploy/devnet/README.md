# EIP-8141 devnet (Docker Compose)

A persistent, single-validator Hegota devnet: ethrex (execution) + Lighthouse (consensus +
validator client), meant to run long-term on the miner host rather than be torn down after a
test run. The fork schedule and genesis workarounds are the same ones proven working in
`test/e2e/kurtosis/eip8141-single-node.yaml` (Osaka at genesis, Amsterdam at epoch 1, Hegota at
epoch 2) — this is a plain-Compose equivalent of that config, without Kurtosis, since Kurtosis is
built for ephemeral test enclaves rather than a service meant to stay up for months.

## Running it

`lighthouse-beacon` needs its own container IP up front, for `--enr-address` - without it, the
ENR it advertises has `ip4: None` (confirmed live) and `lighthouse-beacon-2` has no address to
dial even with a correct ENR. A container that is only *created* has no IP on current Docker
versions (it gets one when it starts), so `docker compose create` followed by `docker inspect`
returns nothing. Compose allocates from the lowest free address of the project network, so the
IP is predictable: ethrex starts first and takes the `.2`, so `lighthouse-beacon` gets the `.3`.
Check the subnet with `docker network inspect eip8141-devnet_default` if in doubt, and confirm
afterwards with `docker inspect` that the running container has the address you passed:

```sh
export GENESIS_TIMESTAMP=$(date +%s)       # required - see note below
docker compose up genesis validator-keys   # one-shot, writes ./data
docker compose up -d ethrex
export LIGHTHOUSE_BEACON_1_IP=172.18.0.3   # ethrex has .2; see above
export LIGHTHOUSE_BEACON_1_ENR=pending     # beacon-2 is not started yet, any value satisfies compose
docker compose up -d --no-deps lighthouse-beacon
```

Then get `lighthouse-beacon`'s ENR and bring up its peer and the validator client. The lighthouse
image has no `wget` or `curl`, but the container's IP is reachable from the host:

```sh
LIGHTHOUSE_BEACON_1_ENR=$(curl -s http://$LIGHTHOUSE_BEACON_1_IP:5052/eth/v1/node/identity | jq -r .data.enr)
export LIGHTHOUSE_BEACON_1_ENR
docker compose up -d --no-deps lighthouse-beacon-2 lighthouse-validator
```

Genesis is `GENESIS_DELAY` (300 s) after `GENESIS_TIMESTAMP`, and Hegota (frame transactions)
starts at epoch 2, another 384 s later. Expect the first blocks about 5 minutes after the
timestamp and frame transactions about 11 minutes after it.

Why two beacon nodes for a "single-validator" devnet: Lighthouse's sync-state machine can never
leave `SyncState::Stalled` with zero connected peers (by design - see the comment on
`lighthouse-beacon-2` in `docker-compose.yml`), and `Stalled` blocks the
`forkchoiceUpdated`-with-attributes calls needed to ever build a first block. `lighthouse-beacon-2`
exists purely to give `lighthouse-beacon` a peer to satisfy that gate - it carries no validators of
its own. Both live on the miner host; this is a libp2p peering requirement, not a networking one,
so there's no reason to split them across machines.

`lighthouse-beacon`'s ENR is stable across restarts (its network identity persists in its own
`--datadir`), so `LIGHTHOUSE_BEACON_1_ENR` only needs to be re-fetched after wiping `./data`.

`lighthouse-validator` auto-discovers keystores under `<datadir>/validators` - there's no separate
"import" step. `eth2-val-tools`' raw output (`keys/<pubkey>/voting-keystore.json` +
`secrets/<pubkey>`) is bind-mounted directly at `/data/validators` and `/data/secrets`, with
`--datadir=/data --secrets-dir=/data/secrets`. `--validators-dir` is not passed: it is mutually
exclusive with `--datadir`.

`GENESIS_TIMESTAMP` must be exported before `genesis` runs. It defaults to `0` (Unix epoch);
`genesis.values.env` only sets `GENESIS_DELAY`, a relative offset from `GENESIS_TIMESTAMP` - not
from "now" - so without this, genesis lands in 1970 and the chain never catches up to real time.

To redo genesis (new timestamp, wipe existing chain data first):

```sh
docker compose down
sudo rm -rf data
export GENESIS_TIMESTAMP=$(date +%s)
docker compose up genesis validator-keys
```

then bring the stack up as above. After a reset, two more things need doing:

- Stop `skandha-miner` and `skandha-gateway` first and delete `~/skandha-data/userOps` on both
  (the mempool and its history belong to the old chain). Keep `peer-id.json` and `enr`, so the
  gateway's `--p2p.bootEnrs` stays valid.
- The chain is empty, so replay the predeploys (`deploy/predeploy/README.md`, "After a devnet
  restart") and put the staking registry address it prints into `stakingRegistryAddress` in both
  nodes' `config.json`. The sidecar answers every `eth_sendFrameTransaction` with `Internal error`
  until the registry has code (`getDepositInfo` returns no data). Addresses can differ from
  before, because they depend on the deployer's nonce history.

### Log size

Without a cap, a container's JSON log grows until the disk is full. On the miner, one such log
reached 7 GB and the full disk stopped the sidecar image from pulling. The miner has
`/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "3" } }
```

(then `sudo systemctl restart docker`; it applies to containers created afterwards, so recreate
the chain containers after adding it). The gateway runs the sidecar under systemd, so its journal is
capped instead, in `/etc/systemd/journald.conf.d/size.conf`: `SystemMaxUse=300M` and
`SystemMaxFileSize=50M`.

RPC is on `localhost:8545`, also reachable at the miner VM's external IP — the privileged
submission endpoint (`ethrex_submitPrivilegedFrameTransaction`, used by the miner's sidecar node)
lives on the same port. It's demo-grade and unauthenticated by design; this deployment leaves it
publicly reachable on purpose, matching this whole devnet's demonstration-only scope. It also
doubles as the redirect target for the gateway node's `eth_sendRawTransaction` (legacy tx
submission, e.g. deploying a factory or paymaster contract).

## Known deploy notes

The Kurtosis config this is derived from is CI-verified end to end; this Compose file was worked
out live against a real VM instead (no local Docker available beforehand to test it against).
Fixed so far during that process:

- `user: "1000:1000"` on the one-shot containers caused a permission error against the
  auto-created bind-mount directories - removed.
- `entrypoint: ["eth2-val-tools"]` was wrong (the binary isn't on `PATH`, only at
  `/app/eth2-val-tools`, the image's own default entrypoint) - removed, letting the image's
  default entrypoint run.
- `eth2-val-tools --out-loc` must be a path that does not already exist - a bind-mount target is
  always pre-created as an empty directory, so it has to be a fresh subdirectory
  (`/data/keystores`), not the mount root itself.
- `lighthouse bn` needs `--allow-insecure-genesis-sync` and `--ignore-ws-check` for a fresh
  single-node devnet - both are standard requirements for any brand-new chain, not specific to
  this setup.
- `GENESIS_TIMESTAMP` defaults to `0` (Unix epoch) - `genesis.values.env` only sets
  `GENESIS_DELAY`, a relative offset from `GENESIS_TIMESTAMP`, not from "now" (documented above).
- Validator import: dropped `lighthouse account validator import` (interactive-only, prompts per
  keystore, fails non-interactively) in favor of `lighthouse vc`'s own auto-discovery, which
  reads `eth2-val-tools`' raw output directly. The keystores are mounted at `<datadir>/validators`
  and `<datadir>/secrets` because `--datadir` and `--validators-dir` are mutually exclusive.
- `docker compose up -d <service>` re-runs the already-completed one-shot `genesis` and
  `validator-keys` services (it re-evaluates the whole dependency chain) and they fail on the
  existing output. Use `--no-deps` for every start after the first.
- A solo beacon node with zero peers never leaves `SyncState::Stalled` (confirmed against
  Lighthouse's real source, `origin/focil` branch - this is intentional, not a bug), which blocks
  it from ever building its own first block. Added `lighthouse-beacon-2`, a passive peer with no
  validators, purely to satisfy the sync-state machine's peer-count gate. See the "Running it"
  section above for the two-step bring-up this requires (node 1's ENR has to exist before node 2
  can dial it).

## Running a devnet in Google Cloud

End-to-end recipe for the public devnet at `https://altmempool.forshtat.com`: one VM running the
Compose stack above, a sidecar node next to it, and Caddy for HTTPS. Everything below was run for
real on this deployment unless marked *untested*. For what testers see, read `devnet-readme.md`.

Set these once in your shell (the values used by the live deployment):

```sh
export PROJECT=hegota-mempool-devnet ZONE=us-central1-a REGION=us-central1
export DOMAIN=altmempool.forshtat.com
export VM=eip8141-miner
```

### 1. Prerequisites

- A GCP project with billing enabled and the Compute Engine API on
  (`gcloud services enable compute.googleapis.com --project=$PROJECT`).
- `gcloud` installed and authenticated (`gcloud auth login`), and
  `gcloud config set project $PROJECT`.
- A domain whose DNS you control. For `forshtat.com` the nameservers are on **Cloudflare**, not the
  registrar, so the record goes there.

### 2. VM, static IP, firewall

**Size matters.** Four Rust processes (ethrex, two beacon nodes, a validator client) catching up
on slots starved an `e2-medium` (2 vCPU / 4 GB): the beacon node's own HTTP API hung. Use
**`e2-standard-4`** (4 vCPU / 16 GB). A 30 GB `pd-balanced` boot disk was enough (about 15 GB used
after four days).

```sh
# Reserve the IP first so DNS never has to change (the live VM had an ephemeral IP promoted to
# static afterwards with `addresses create --addresses=<ip>`; this order is the tidier one - untested).
gcloud compute addresses create eip8141-miner-ip --project=$PROJECT --region=$REGION
IP=$(gcloud compute addresses describe eip8141-miner-ip --project=$PROJECT --region=$REGION --format='get(address)')

gcloud compute instances create $VM --project=$PROJECT --zone=$ZONE \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=eip8141-miner-ip \
  --tags=eip8141-miner

gcloud compute firewall-rules create eip8141-miner-p2p --project=$PROJECT \
  --allow=tcp:4337,udp:4337 --target-tags=eip8141-miner --source-ranges=0.0.0.0/0   # sidecar libp2p
gcloud compute firewall-rules create eip8141-miner-rpc --project=$PROJECT \
  --allow=tcp:8545 --target-tags=eip8141-miner --source-ranges=0.0.0.0/0            # ethrex RPC, direct
gcloud compute firewall-rules create eip8141-miner-web --project=$PROJECT \
  --allow=tcp:80,tcp:443 --target-tags=eip8141-miner --source-ranges=0.0.0.0/0      # Caddy
```

Port `14337` (the sidecar's own RPC) is deliberately **not** opened; Caddy reaches it on localhost.
Drop the `eip8141-miner-rpc` rule if you do not want ethrex reachable over plain HTTP on the raw
IP. The second, e2-micro VM (`eip8141-gateway`) runs the gateway sidecar node, see
[Gateway node](#gateway-node) below; it has its own `eip8141-gateway-p2p` (4337) and
`eip8141-gateway-rpc` (14337) firewall rules.

### 3. Docker

```sh
gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE --command='
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER
  sudo systemctl enable --now docker'
```

Log out and back in (or reconnect) so the `docker` group applies.

### 4. The chain: ethrex + Lighthouse

Get the repo onto the VM. The branch is `master` of `forshtat/mempool-workshop-sidecar`; cloning it gives you both
the Compose files and the sidecar source used in step 5.

```sh
gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE
# --- on the VM from here ---
git clone --depth 1 --branch master https://github.com/forshtat/mempool-workshop-sidecar.git ~/skandha
cp -r ~/skandha/deploy/devnet ~/devnet && cd ~/devnet
```

(The live deployment copied `deploy/devnet` over with `gcloud compute scp` and shipped the sidecar
source as a `git archive` tarball, so the VM has no `.git` and nothing records which commit it is
running. Cloning avoids that; `git -C ~/skandha rev-parse HEAD` then tells you.)

Bring up the chain with the two-step sequence from ["Running it"](#running-it), using
`--no-deps` for everything after the first step. Without it, `docker compose up -d <service>`
re-evaluates the whole dependency chain, re-runs the already-completed one-shot `genesis` and
`validator-keys` containers, and they fail because their output already exists.

```sh
export GENESIS_TIMESTAMP=$(date +%s)             # required, see "Running it"
docker compose up genesis validator-keys          # one-shot; writes ./data
docker compose up -d --no-deps ethrex
docker compose create --no-deps lighthouse-beacon
export LIGHTHOUSE_BEACON_1_IP=$(docker inspect eip8141-devnet-lighthouse-beacon-1 \
  --format '{{range $n, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}')
docker compose up -d --no-deps lighthouse-beacon
# wait ~10 s for the beacon HTTP API, then:
export LIGHTHOUSE_BEACON_1_ENR=$(docker compose exec -T lighthouse-beacon \
  wget -qO- http://localhost:5052/eth/v1/node/identity | jq -r .data.enr)
docker compose up -d --no-deps lighthouse-beacon-2 lighthouse-validator
```

Persist both values in `~/devnet/.env` so a later `docker compose up`/recreate does not fail on
the required-variable check or pick up a wrong peer address:

```sh
printf 'LIGHTHOUSE_BEACON_1_IP=%s\nLIGHTHOUSE_BEACON_1_ENR=%s\n' \
  "$LIGHTHOUSE_BEACON_1_IP" "$LIGHTHOUSE_BEACON_1_ENR" > .env
```

> On the live VM `.env` still contains `LIGHTHOUSE_BEACON_1_ENR=placeholder` from an early debugging
> step, so recreating `lighthouse-beacon-2` from that file would give it a bogus boot node. Write
> the real ENR as above.

`GENESIS_DELAY` is 300 s, so nothing is produced until then. Then check that blocks advance:

```sh
watch -n6 "curl -s localhost:8545 -H 'content-type: application/json' \
  --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}'"
```

Amsterdam activates at epoch 1 (192 s after genesis) and Hegota at epoch 2 (384 s). Frame
transactions are only valid after that.

### 5. The sidecar

The miner runs the sidecar from the Docker image CI publishes on every push to `master`
(`ghcr.io/forshtat/mempool-workshop-sidecar:latest`; see `.github/workflows/` for the "Publish Docker
image" job), not from a local build — only `config.json` is bind-mounted from the host. GHCR
creates the package private on its first publish: make it public once (GitHub > Packages >
mempool-workshop-sidecar > Package settings), or the VM's `docker pull` fails without a login.

```sh
# --- on the VM ---
mkdir -p ~/skandha ~/skandha-data
# config.json goes in ~/skandha/ (see below); no bun/build step needed here.
```

`~/skandha/config.json` (`relayers` holds the throwaway key from the bottom of this file; the
address is the premined one):

```json
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    { "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa" }
  ],
  "relayers": ["0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15"],
  "rpcEndpoint": "http://localhost:8545",
  "rpcEndpointSubmit": "http://localhost:8545",
  "stakingRegistryAddress": "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f"
}
```

All three entry-point fields must be the fixed sentinel `0x…00aa`; a stale 4337-style address
silently disables gossip. Both RPC endpoints point at the local ethrex, which is what makes
`--redirectRpc` and the privileged relay work. `stakingRegistryAddress` is the deployed
`NaiveStakingRegistry` (see [deployments/devnet.md](../../deployments/devnet.md)); confirm a
running node picked it up with `skandha_config`.

Run it as a service. Replace `alexf` with your user and `34.67.41.151` with the reserved IP
(`$IP`); the ENR host must be the public address, not the internal one:

```ini
# /etc/systemd/system/skandha-miner.service
[Unit]
Description=sidecar miner node (EIP-8141 devnet, Docker)
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f skandha-miner
ExecStartPre=/usr/bin/docker pull ghcr.io/forshtat/mempool-workshop-sidecar:latest
ExecStart=/usr/bin/docker run --rm --name skandha-miner --network host \
  -v /home/alexf/skandha/config.json:/usr/app/config.json:ro \
  -v /home/alexf/skandha-data:/usr/app/data \
  ghcr.io/forshtat/mempool-workshop-sidecar:latest node \
  --configFile /usr/app/config.json --dataDir /usr/app/data \
  --api.address 0.0.0.0 --api.port 14337 --api.wsPort 14337 \
  --p2p.host 0.0.0.0 --p2p.enrHost 34.67.41.151 --p2p.port 4337 --p2p.enrPort 4337 \
  --p2p.retainPeerId \
  --executor.bundlingMode auto --redirectRpc --explorer.enable
ExecStop=/usr/bin/docker stop -t 10 skandha-miner
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now skandha-miner
curl -s localhost:14337/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

`auto` bundling is required: only the auto-mode cron runs `MempoolReconciler`, which is what marks
a transaction `OnChain`. `--p2p.retainPeerId` keeps the ENR stable across restarts. The node's ENR
is printed in its log (`journalctl -u skandha-miner | grep 'ENR:'`); give that to anyone who wants
to peer.

### 6. HTTPS with Caddy

1. Create the DNS record (Cloudflare): `A`, name `altmempool`, content = the reserved IP, proxy
   status **DNS only** (grey cloud), so Let's Encrypt validates against the VM directly.
2. Wait until `dig +short $DOMAIN` returns the IP. Only then activate Caddy, otherwise repeated
   failed ACME validations hit Let's Encrypt's rate limits.
3. Install Caddy and load the config:

```sh
# --- on the VM ---
sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq && sudo apt-get install -y -qq caddy

sudo tee /etc/caddy/Caddyfile <<'EOF'
altmempool.forshtat.com {
	# sidecar bundler (frame-tx alt mempool) JSON-RPC and WebSocket
	handle /rpc* {
		reverse_proxy localhost:14337
	}
	# Everything else: ethrex JSON-RPC
	handle {
		reverse_proxy localhost:8545
	}
}
EOF
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate itself. The `handle` blocks give one hostname for both
backends: `/rpc*` goes to the sidecar, everything else to ethrex. Note that because Caddy connects to
The sidecar from localhost, the sidecar's localhost-only gate on `debug_bundler_*` no longer protects
anything. Block those paths here if you care.

### 7. Verify

```sh
curl -s -X POST https://$DOMAIN -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'        # ethrex -> 0x539
curl -s -X POST https://$DOMAIN/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_config","params":[]}'     # the sidecar
```

Then send a frame transaction as in `devnet-readme.md` section 2.2; it should reach `OnChain` in
about 10 seconds.

### 8. Operating it

- **Logs:** `docker compose logs -f ethrex` (in `~/devnet`), `journalctl -u skandha-miner -f`,
  `journalctl -u caddy -f`. The ethrex log level is the `--log.level` line in `docker-compose.yml`;
  `debug` is very chatty, so put it back to `info` when done and recreate only that container:
  `docker compose up -d --no-deps ethrex`.
- **Disk:** the `data/` directory (owned by root, created by the containers) grows with the
  chain; `df -h /` occasionally.
- **After a VM reboot (not resilient today):** the containers have no restart policy, so ethrex and
  Lighthouse stay down. Caddy and `skandha-miner` come back on their own (both are enabled), fronting
  a dead chain. To recover: `cd ~/devnet && docker compose up -d --no-deps ethrex
  lighthouse-beacon lighthouse-beacon-2 lighthouse-validator`. `lighthouse-beacon-1`'s
  `--enr-address` is its container IP, which may differ after a restart; if it does, re-run the
  `create` / `docker inspect` / ENR steps from step 4. *Untested on the live devnet.*
  Adding `restart: unless-stopped` to the four long-running services in `docker-compose.yml` is the
  obvious hardening.
- **Redoing genesis:** see above ("To redo genesis"). Afterwards re-fetch the beacon ENR
  (step 4), restart `skandha-miner`, and expect the sidecar's mempool to be empty.
- **Updating the sidecar:** the miner runs `ghcr.io/forshtat/mempool-workshop-sidecar:latest`, which CI
  rebuilds and pushes on every push to `master` (the "Publish Docker image" workflow;
  `gh run list --repo forshtat/mempool-workshop-sidecar --branch master` to check it landed - it normally takes
  a couple of minutes after the merge). Updating is then just
  `sudo systemctl restart skandha-miner`, whose `ExecStartPre` does the `docker pull` before
  restarting the container. The public RPC is down for the few seconds between stop and start.
  `~/skandha-data` (bind-mounted, separate from the container) is untouched, so the mempool and
  peer id survive; the in-memory explorer history does not. `config.json` lives at
  `~/skandha/config.json` on the host (bind-mounted read-only into the container); editing it also
  needs a restart to take effect. (`~/skandha` itself needs no `bun install`/build step any more -
  that's a leftover from before this VM moved to the Docker image; a local build is only still
  needed to produce the tree the **gateway** copies, see below.)
- **Gateway node:** see the next section.
- **Updating ethrex:** `docker compose pull ethrex && docker compose up -d --no-deps ethrex`. The
  image tag `eip8141-tracer-latest` follows the `eip8141-tracer` branch of `forshtat/ethrex`.

### Gateway node

The devnet tests the network end to end with two sidecar nodes. Transactions are meant to be sent to
the **gateway** (`eip8141-gateway`, e2-micro, reserved static IP `34.132.84.247` as
`eip8141-gateway-ip`, served over HTTPS at `altmempoolgateway.forshtat.com`); it validates them and
gossips them over p2p to the **miner** (`eip8141-miner`), which re-validates them, relays them to its
local ethrex and reconciles them to `OnChain`. The gateway has no chain of its own: its
`config.json` is the miner's with `rpcEndpoint` and `rpcEndpointSubmit` set to the miner's ethrex on
the internal network (`http://10.128.0.5:8545`; the default `default-allow-internal` rule allows it).

The gateway runs the **same Docker image as the miner** (`ghcr.io/forshtat/mempool-workshop-sidecar:latest`),
so the two cannot run different rule sets. Docker has to be installed on it (`sudo apt-get install -y docker.io`);
a 1 GB VM cannot build the sidecar, but it runs the published image. Unit
`/etc/systemd/system/skandha-gateway.service`:

```ini
[Unit]
Description=sidecar gateway node (EIP-8141 devnet, Docker)
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f skandha-gateway
ExecStartPre=/usr/bin/docker pull ghcr.io/forshtat/mempool-workshop-sidecar:latest
ExecStart=/usr/bin/docker run --rm --name skandha-gateway --network host --env-file /etc/skandha-gateway.env \
  -v /home/alexf/skandha/config.json:/usr/app/config.json:ro \
  -v /home/alexf/skandha-data:/usr/app/data \
  ghcr.io/forshtat/mempool-workshop-sidecar:latest node \
  --configFile /usr/app/config.json --dataDir /usr/app/data \
  --api.address 0.0.0.0 --api.port 14337 --api.wsPort 14337 \
  --p2p.host 0.0.0.0 --p2p.enrHost 34.132.84.247 --p2p.port 4337 --p2p.enrPort 4337 \
  --p2p.retainPeerId --p2p.bootEnrs <the miner's ENR> \
  --executor.bundlingMode manual --redirectRpc --explorer.enable
ExecStop=/usr/bin/docker stop -t 10 skandha-gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Both nodes pull `:latest` when their unit starts, so `sudo systemctl restart skandha-miner skandha-gateway`
upgrades them together. Check that they found each other afterwards: `skandha_explorer_peers` must list the other
node on **both** (an empty list on the gateway means frame transactions are admitted but never reach the miner).
The gateway needs about 40 seconds to start on this VM.

*History:* on 2026-10-24 frame transactions were admitted by the gateway but never mined, because the two nodes
had no working p2p link. Two startup-order bugs caused it, both fixed in the sidecar: the peer manager started
listening for connections only after discovery had already dialed the boot node, so the gateway never registered the
miner as a peer (`d6a85ff`); and gossipsub started after the peer manager dialed, so the peers synced over
request/response but could not gossip, and publishing failed with `NoPeersSubscribedToTopic` (`7e51741`). At the same
time the gateway moved from a bare-metal bun build to this Docker image, and got the faucet. If `skandha_explorer_peers`
is empty on either node, or the gateway logs `NoPeersSubscribedToTopic`, suspect this area first.

`manual` bundling keeps the gateway from relaying anything itself: the miner is the only node that
mines. The gateway still follows the chain: every 10 seconds it looks up the receipts of the
transactions it holds, so a transaction it forwarded shows `OnChain` (or `Reverted`) there too once
the miner has included it. It stays `New` on the gateway only until then. The miner's ENR is in its
log (`journalctl -u skandha-miner | grep 'ENR:'`); it stays the same as long as `--p2p.retainPeerId`
is set and the enrHost does not change.

**The faucet runs on the gateway.** Everything a workshop participant does goes through the gateway
(`https://altmempoolgateway.forshtat.com/rpc`): frame transactions, raw transactions (which it
forwards to ethrex), `eth_*` reads and the faucet (`skandha_explorer_faucet`, the explorer's "Faucet"
button). It needs its own account, **not** the throwaway genesis key above, which is published in this
repo: anyone could drain it. Generate a fresh key, send it a bounded amount from the genesis account
(this is the most the faucet can ever give away), and put the key in a root-only env file that the
unit above reads:

```sh
# --- on the gateway VM ---
KEY=0x$(openssl rand -hex 32)
echo "SKANDHA_FAUCET_KEY=$KEY" | sudo tee /etc/skandha-gateway.env >/dev/null
sudo chmod 600 /etc/skandha-gateway.env
sudo systemctl daemon-reload && sudo systemctl restart skandha-gateway
curl -s localhost:14337/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_info","params":[]}'   # "faucetEnabled": true
```

The node logs `[x] FAUCET (skandha_explorer_faucet, from 0x…)` at start; fund that address (e.g. 5,000
ETH from the genesis key, with any wallet or `cast send`) and keep it topped up. The faucet sends
through the gateway's `rpcEndpoint`, the miner's ethrex. Without `SKANDHA_FAUCET_KEY` the node starts
normally and just has no faucet (`info` omits `faucetEnabled`, the explorer hides the button). The
limits are one request per address per hour and 100 per hour overall; see
[`docs/sidecar_explorer.md`](../../docs/sidecar_explorer.md#skandha_explorer_faucet). Check it with a
throwaway address (it sends 1 ETH, once per address per hour):

```sh
curl -s -X POST https://altmempoolgateway.forshtat.com/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_faucet","params":["0x000000000000000000000000000000000000dEaD"]}'
```

TLS: an `A` record `altmempoolgateway` -> `34.132.84.247` on Cloudflare, **DNS only** (Caddy needs
to reach the origin itself to obtain its certificate), the `eip8141-gateway-web` firewall rule
(tcp 80 and 443), and Caddy with this `/etc/caddy/Caddyfile`:

```
altmempoolgateway.forshtat.com {
	handle /rpc* {
		reverse_proxy localhost:14337
	}
	handle {
		respond "EIP-8141 devnet gateway. JSON-RPC and WebSocket at /rpc." 200
	}
}
```

If Caddy tried before the record resolved, `sudo systemctl restart caddy` retries immediately.

Check the link with `skandha_explorer_peers` on both nodes (each lists the other), then send a frame
transaction to the gateway and follow it on the miner's `skandha_frameTransactionStatus`.

### 9. Tearing it down

```sh
gcloud compute instances delete $VM --project=$PROJECT --zone=$ZONE
gcloud compute addresses delete eip8141-miner-ip --project=$PROJECT --region=$REGION
gcloud compute firewall-rules delete eip8141-miner-p2p eip8141-miner-rpc eip8141-miner-web --project=$PROJECT
```

Then remove the DNS record. Deleting the VM destroys the chain state, and the next bring-up starts
from a new genesis.

### 10. Predeploying the contract library

After every devnet restart (a new genesis), put the mainnet contract library back:

```sh
# from the repo root, with bun install already run in deploy/predeploy
bun run predeploy fund          # sends devnet ETH to the deployer if it is low
bun run predeploy run --all     # replays the fetched mainnet deployments
bun run predeploy verify --all  # read-only checks; exits 1 on any failure
```

The deployer starts at nonce 0 on a fresh chain and `--all` runs in a fixed order, so the
addresses are the same every time (listed in `devnet-readme.md`), provided nothing else has sent
transactions from the deployer key (the tool refuses to continue if it detects that). If they ever
change, update that table from `bun run predeploy list`. Details, and how to add a protocol, are in
`deploy/predeploy/README.md`.

## Throwaway devnet key

`genesis.values.env` and `docker-compose.yml` both reference a single premined address,
committed on purpose — this is a devnet with no real stake behind it, same reasoning as
`test/e2e/kurtosis/eip8141-single-node.yaml`'s own throwaway key:

- private key: `0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15`
- address: `0x5544596212F91984C986A919C8026DF0576816f9`
