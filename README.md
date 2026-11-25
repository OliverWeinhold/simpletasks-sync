# SimpleTasks Sync - Encrypted Sync Server for SimpleTasks

SimpleTasks Sync is the server behind the optional sync in [SimpleTasks](https://simpletasks.eu), a small to-do app for Windows, Linux and Android. It stores end-to-end encrypted packets and hands them out again in order. It never sees task texts, lists or keys, and it has no user accounts.

![License](https://img.shields.io/github/license/OliverWeinhold/simpletasks-sync?label=License&color=blue)
![Node Version](https://img.shields.io/badge/Node%20%E2%89%A5%2024-grey)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/OliverWeinhold/simpletasks-sync?label=Code%20Size&color=2ea043)

> [!TIP]
> You do not need your own server. SimpleTasks uses `https://sync.simpletasks.eu` by default. How sync works from the user's side is explained on [simpletasks.eu/en/sync](https://simpletasks.eu/en/sync).

## Table of Contents

- [Features](#features)
- [How it works](#how-it-works)
- [What the server knows](#what-the-server-knows)
- [Installation](#installation)
  - [Requirements](#requirements)
  - [Docker](#docker)
  - [Without Docker](#without-docker)
  - [Reverse proxy](#reverse-proxy)
- [Configuration](#configuration)
- [Operations](#operations)
- [Running a public instance](#running-a-public-instance)
- [File Structure](#file-structure)
- [Development](#development)
- [License](#license)
- [Author / Maintainer](#author--maintainer)
- [Contributions](#contributions)

## Features

- **End-to-end encrypted**: Packets are encrypted on the devices with AES-256-GCM. The server only stores and returns them.
- **No accounts**: No email, no password, no names. A vault is addressed by a random id that the app derives from the sync code.
- **No runtime dependencies**: Node 24 runs the TypeScript sources directly and uses the built-in `node:sqlite`. No build step.
- **Small**: About 600 lines of TypeScript, so you can read all of it before you trust it.
- **No access logs**: IP addresses are only kept in memory for rate limiting, one minute at most.
- **Limits**: Per vault, per IP, for the whole database and for the memory used by uploads, so one user cannot fill the disk or crash the server.
- **Cleans up**: Old packets are dropped once a snapshot replaces them, inactive vaults are deleted after 90 days.
- **Docker**: Read-only container without capabilities, with resource limits and a health check.

## How it works

The app creates a random sync code (128 bit) on the first device. From that code it derives three values with HKDF.

| Value | Who knows it | Used for |
| --- | --- | --- |
| Vault id | devices and server | address of the vault, not secret |
| Auth token | devices, server keeps a SHA-256 hash | access to the vault |
| Data key | devices only | AES-256-GCM encryption of every packet |

The server stores packets per vault with a sequence number and returns everything after the last number a device has seen. Merging happens in the app. After about 300 packets a device uploads an encrypted snapshot of the full state and the server deletes the older packets. Other devices join by scanning a QR code or pasting a pairing text.

The full protocol is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## What the server knows

It knows the vault id, when packets were uploaded or fetched, their padded size and the IP address of a request while it is handled. It does not know task contents, the number of tasks, settings, the sync code or who you are.

The server does not write access logs. Turn off the access log of your reverse proxy as well (see [nginx.example.conf](nginx.example.conf)).

## Installation

### Requirements

- Docker with Compose, or Node.js 24 or newer
- A reverse proxy with TLS (nginx, Traefik, Caddy). The server itself only speaks plain HTTP.
- A domain or subdomain, for example `sync.example.com`

### Docker

```sh
git clone https://github.com/OliverWeinhold/simpletasks-sync.git
cd simpletasks-sync
cp docker-compose.example.yml docker-compose.yml
mkdir data && sudo chown 1000:1000 data
docker compose up -d --build
curl http://127.0.0.1:8463/v1/health
```

The container listens on port 8463 and is only reachable from the host. If that port is taken, put `SYNC_PORT=9000` (or any free port) into a `.env` file next to `docker-compose.yml`. Only the host side changes.

### Without Docker

```sh
git clone https://github.com/OliverWeinhold/simpletasks-sync.git
cd simpletasks-sync
npm start
```

The server listens on `127.0.0.1:8463` and writes its database to `./data/sync.db`. Use systemd or similar to keep it running.

### Reverse proxy

Point your proxy to `127.0.0.1:8463` (or your `SYNC_PORT`). A complete nginx server block is in [nginx.example.conf](nginx.example.conf). It sets `client_max_body_size 10m`, turns off the access log and overwrites `X-Forwarded-For` with the real client address.

Then open SimpleTasks, go to Settings, Data, Synchronization and replace the server address with `https://your-domain`.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address to listen on |
| `PORT` | `8463` | Port to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Folder for `sync.db` |
| `SYNC_MAX_BLOB_BYTES` | `1048576` | Max size of one change packet |
| `SYNC_MAX_VAULT_BYTES` | `5242880` | Max size of one vault, also the limit for a snapshot |
| `SYNC_MAX_TOTAL_BYTES` | `2147483648` | Max size of all vaults together (2 GiB). When reached, no new vaults are created and no vault can grow. `0` for no limit |
| `SYNC_MAX_NEW_VAULTS_PER_DAY` | `200` | New vaults per 24 hours, `0` for no limit |
| `SYNC_RATE_LIMIT` | `120` | Requests per minute and vault. Failed logins count per IP, new vaults are limited to 5 per minute and IP. IPv6 counts per /64. `0` turns all of it off |
| `SYNC_INACTIVE_DAYS` | `90` | Vaults not used for this long are deleted, `0` keeps them |
| `TRUST_PROXY` | `true` | Read the client IP from the last `X-Forwarded-For` entry. Set to `false` if the port is reachable without your proxy |

For private use the defaults are generous. A typical vault is well below 1 MB. With 1000 active users expect roughly 100 to 300 MB of data.

Node runs the server on a single thread, so it uses one CPU core at most. The compose example still sets `cpus`, `mem_limit` and `pids_limit`, plus log rotation.

## Operations

- **Backup**: Copy the `data` folder, or run `sqlite3 data/sync.db ".backup backup.db"` while the server is running. The content is encrypted, so the backup may live on storage you do not fully trust.
- **Update**: `git pull` and `docker compose up -d --build`. The database schema is versioned and only ever extended.
- **Monitoring**: `GET /v1/health` returns `{"ok":true,...}` without authentication, `HEAD /v1/health` returns 200 without a body.
- **Cleanup**: Inactive vaults are removed at start and then every hour.
- **Container keeps restarting** with "data directory ... is not writable": the `data` folder on the host belongs to the wrong user. Run `sudo chown -R 1000:1000 data`.

## Running a public instance

If you offer the server to other people, you are responsible for the metadata it processes (IP addresses during requests, vault ids, timestamps). You will likely need a privacy policy, a data processing agreement with your hosting provider and short terms of use (no warranty, limits, deletion after inactivity, no recovery without the sync code). This is not legal advice.

## File Structure

- `/src/` - The server: `index.ts` (start), `server.ts` (HTTP routes), `db.ts` (SQLite), `auth.ts`, `ratelimit.ts`, `config.ts`.
- `/test/` - Tests with `node:test`. They start real servers on random ports.
- `/docs/PROTOCOL.md` - HTTP protocol, packet format and test vector.
- `/data/` - Created at start and holds `sync.db`. Not part of the repository.
- `Dockerfile`, `docker-compose.example.yml`, `nginx.example.conf` - Deployment.

## Development

```sh
npm install        # only typescript and @types/node, for type checks
npm test
npm run typecheck
npm run dev        # restarts on changes
```

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPLv3). If you run a modified version as a public service, you have to publish your changes. See the [LICENSE](LICENSE) file for details.

## Author / Maintainer

- [Oliver Weinhold](https://oliverweinhold.de/)

## Contributions

Issues and pull requests are welcome. Please report security problems by email to contact@simpletasks.eu instead of opening a public issue.
