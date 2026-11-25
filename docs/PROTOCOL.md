# Sync protocol v1

The contract between the SimpleTasks app and this server. Everything needed
to write another client is in this file.

The server is deliberately dumb. It stores encrypted packets (blobs), numbers
them per vault and returns them in order. It never decrypts anything.

## Basics

- All paths start with `/v1`. Breaking changes get `/v2`.
- Requests and responses are JSON in UTF-8.
- TLS is done by a reverse proxy, the server itself speaks HTTP.
- No CORS. The web version of SimpleTasks does not offer sync and the apps
  use the Tauri HTTP plugin, not the browser fetch.
- Vault routes need `Authorization: Bearer <authToken>`. The token is 32
  random bytes as base64url (43 characters). The server stores
  `SHA-256(token)` in hex and compares in constant time.
- Vault id is 16 bytes as base64url (22 characters, `A-Z a-z 0-9 - _`).
- Blobs are base64url text. The server only checks characters and length.

## Errors

Always JSON with an `error` field, for example `{"error":"unauthorized"}`.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `badRequest` | Malformed request, id or field |
| 401 | `unauthorized` | Token missing or wrong |
| 404 | `vaultNotFound` | Vault does not exist |
| 404 | `noSnapshot` | Only `GET .../snapshot`, no snapshot yet |
| 404 | `notFound` | Unknown path |
| 405 | `methodNotAllowed` | Known path, wrong method |
| 409 | `exists` | Vault already exists |
| 409 | `olderSnapshot` | Snapshot is older than the stored one |
| 410 | `gone` | Requested packets were folded into a snapshot, with `snapshotSeq` |
| 413 | `tooLarge` | Blob, request or vault over the limit |
| 429 | `rateLimited` | Too many requests or too many new vaults |
| 507 | `serverFull` | The server reached its total storage limit |
| 500 | `server` | Anything else |
| 503 | `busy` | Too many large uploads at the same time, try again later |

An unknown vault is reported as 404 before the token is checked. The app uses
this to tell "vault was deleted" from "wrong sync code". The vault id is not
secret, so this leaks nothing useful.

## Endpoints

### `GET /v1/health`

No authentication, no rate limit. `HEAD` works as well.

```json
{ "ok": true, "protocol": 1, "limits": { "maxBlobBytes": 1048576, "maxVaultBytes": 5242880 } }
```

### `POST /v1/vaults`

Creates a vault. Header `Authorization: Bearer <authToken>`.

```json
{ "vaultId": "C7-v7I1Q17xW3jA2wU8pEQ" }
```

- `201` `{"vaultId": "..."}`
- `409` `exists`, practically never happens because the id comes from a new random code. The app shows an error
- `429` `rateLimited` when the daily limit of new vaults is reached
- `507` `serverFull` when the server reached its total storage limit

### `POST /v1/vaults/{vaultId}/ops`

Uploads 1 to 20 packets.

```json
{ "ops": [ { "opId": "3f9c0a...", "blob": "AQ..." } ] }
```

- `opId` is random and unique per packet (8 to 64 characters of
  `A-Z a-z 0-9 - _`). If it is already stored in this vault, nothing new is
  stored and the existing seq is returned. The app retries uploads after
  connection problems, so this matters.
- New packets get the next seq of the vault, starting at 1, without gaps.
- All or nothing. If one packet is invalid or the vault would get too large,
  nothing is stored (`413`, or `507` when the whole server is full).

Response `200`

```json
{ "seqs": [41, 42], "latestSeq": 42 }
```

### `GET /v1/vaults/{vaultId}/ops?since=<seq>&limit=<n>`

Returns packets with `seq > since` in ascending order, at most `limit`
(default 200, max 500).

```json
{
  "ops": [ { "seq": 42, "opId": "...", "blob": "AQ..." } ],
  "hasMore": false,
  "latestSeq": 42,
  "snapshotSeq": 0
}
```

- `latestSeq` is the highest seq ever handed out, also when `ops` is empty.
- `snapshotSeq` is `upToSeq` of the current snapshot, or 0.
- If `since < snapshotSeq` the packets are gone. Response
  `410 {"error":"gone","snapshotSeq":300}`. The app then loads the snapshot
  and continues from `snapshotSeq`.

### `GET /v1/vaults/{vaultId}/snapshot`

`200 {"upToSeq": 300, "blob": "AQ..."}` or `404 {"error":"noSnapshot"}`.

### `PUT /v1/vaults/{vaultId}/snapshot`

```json
{ "upToSeq": 300, "blob": "AQ..." }
```

- The snapshot is the encrypted full state up to and including `upToSeq`.
  It may be larger than a change packet, the limit is the vault size.
- `upToSeq` must be between 0 and `latestSeq` (else 400) and not lower than
  the stored one (else `409 olderSnapshot`).
- The server deletes all packets with `seq <= upToSeq`. Seqs are never
  reused.
- Response `204`.

The app writes a new snapshot after about 300 packets.

### `DELETE /v1/vaults/{vaultId}`

Deletes the vault with all packets and the snapshot. Response `204`.

## Guarantees the app relies on

1. Seqs per vault are strictly increasing and without gaps.
2. A packet is stored once (idempotent by `opId`).
3. Packets are returned in the order they were stored.
4. Deleted packets are reported with 410, never silently skipped.
5. Blobs are returned exactly as uploaded.

## Packet format (for reference, the server never sees this)

```
blob = base64url( version 1 byte | iv 12 bytes | AES-256-GCM ciphertext with 16 byte tag )
plaintext = length 4 bytes big endian | data | zero padding
```

Version 1 has plain JSON as data, version 2 JSON packed with deflate (zlib).
Version 2 appends `|v2` to the additional data.

Padding goes to 256 B, 1 KiB, 4 KiB, 16 KiB, 64 KiB, then multiples of
64 KiB. Additional data is `simpletasks-sync-v1|<vaultId>|ops` or `...|snapshot`
(plus `|v2` for version 2).

Decrypted, a packet looks like this.

```json
{
  "v": 1,
  "device": "a1b2c3d4e5f6",
  "ops": [
    { "k": "task", "id": "9f...", "f": { "TaskText": ["Milk", "000001764000000:00000:a1b2c3d4e5f6"] } },
    { "k": "task", "id": "7a...", "del": "000001764000123:00000:a1b2c3d4e5f6" }
  ]
}
```

## Test vector

Sync code `008J-4CT4-ANK7-F24S-NAXW-SQFE-ZWD` (bytes `00 11 22 ... ff`) gives

| | |
| --- | --- |
| Vault id | `C7-v7I1Q17xW3jA2wU8pEQ` |
| Auth token | `g7vOM7Wj5Q-5zopxHMC3rcnl8Zu44BJgYKqMm-THA_c` |

HKDF-SHA-256 with salt `simpletasks-sync-v1` and info `vault-id`,
`auth-token`, `data-key`.
