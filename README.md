# BigCommerce CLI (bcli)

A CLI for BigCommerce — search customers, export filtered data to CSV, look up orders, and manage multi-store environments. **MCP-ready**: every command is exposed as a tool for agents like Claude Code or Cursor.

## Install

Install globally from npm so the `bcli` binary is on your `PATH`:

```sh
npm install -g @thereis/bcli
# or
pnpm add -g @thereis/bcli
```

> Use the **global** install so your shell resolves `bcli` directly — no `pnpm bcli` or custom bash shim needed.

## Usage

### 1. Setup

Run the interactive wizard:

```sh
bcli setup
```

It prompts for store hash + API token, optional pretty logging, and (optionally) pulls your store's custom form fields so `export customers` can validate `--field` args. Credentials go to `~/.bcli/<env>.env`; form fields to `~/.bcli/form-fields.json`.

Add more environments with `bcli setup --env production`.

### 2. Common examples

```sh
bcli check connection
bcli get customer user@example.com
bcli get order 12345
bcli get orders --email user@example.com

bcli export customers fdd \
  --field "Full due diligence is complete" \
  --value "True" \
  --columns "Email:email,Country:addresses[0].country" \
  --export

# Export every customer in retryable batches using a saved column mapping
bcli export customers customer-migration \
  --all \
  --columns-file mappings/customer-migration.json \
  --batch-size 1000 \
  --request-delay-ms 250 \
  --concurrency 8 \
  --export

# Export the 100 oldest customers as a sample
bcli export customers customer-sample \
  --all \
  --limit 100 \
  --columns-file mappings/customer-migration.json \
  --export

# Resume from the first incomplete batch
bcli export customers customer-migration --resume --export
```

The included migration mapping generates `customerId` with `{uuidv4}` and
keeps the original BigCommerce ID in `bigcommerceId`. Generated UUIDs are saved
before each CSV batch is published, so retrying an incomplete batch reuses the
same IDs. `addresses[last]` selects the final saved address returned by the
customer API. It does not query the billing address from the latest order.

#### Stream every customer to one CSV (fastest)

```sh
bcli export customers customer-migration-stream \
  --all --stream \
  --columns-file mappings/customer-migration.json \
  --concurrency 16 \
  --export
```

`--stream` pages through `/customers` with `include=addresses,formfields` and
writes rows to CSV as each page arrives. One request returns 250 fully
hydrated customers, so a three-million-customer store costs about 12,900
requests instead of the 72,000 the batched exporter needs (a roster pass of
12,900 pages that keeps only the IDs, plus 64,497 fetches of 50 IDs each).

Memory stays flat: a page is fetched, mapped, appended, and dropped. Nothing
accumulates.

`--concurrency` splits the page range into that many contiguous shards, each
writing its own part file. The parts are concatenated into a single
`<prefix>.csv` when every shard finishes.

```text
exports/customer-migration-stream/
├── stream-state.json                  next page + byte offset per shard
├── customer-migration-stream-part-001.csv
├── customer-migration-stream-part-002.csv
└── customer-migration-stream.csv      the merged result
```

A streamed run and a batched run cannot share an export key. Starting either
one against a directory that already holds the other is rejected.

`--resume --export` continues from each shard's last completed page. Part files
are truncated to the byte offset recorded in `stream-state.json` first, so a
half-written row from a killed process is discarded rather than corrupting the
output.

This relies on offset pagination staying stable during the run, which holds
when customers are never deleted. If your store deletes customers, use the
batched exporter below instead.

#### Export customers in batches

Start a full export with a new export key:

```sh
bcli export customers customer-migration-v1 \
  --all \
  --batch-size 1000 \
  --request-delay-ms 250 \
  --concurrency 8 \
  --columns-file mappings/customer-migration.json \
  --export
```

`--batch-size 1000` writes at most 1,000 customers to each CSV file. The
default batch size is 1,000, and the maximum is 10,000.

Keep the batch size at or above 50. Customer details are fetched 50 IDs per
request, so a smaller batch wastes most of each request: `--batch-size 1`
turns a three-million-customer export into three million requests instead of
sixty thousand.

`--request-delay-ms 250` waits 250 milliseconds between roster-page and
customer-detail requests. The export also retries HTTP 429 responses using
BigCommerce's rate-limit reset header. Each roster page is checkpointed to
disk, so `--resume` continues from the next page instead of starting over.
The manifest saves the delay, so `--resume` also keeps the same setting.

A 250-millisecond delay caps this exporter at about four requests per second.
The store quota is shared with other apps, so a fixed delay cannot prevent
every 429 response. The reset-header retry remains the final safeguard.

`--concurrency 8` runs up to eight export requests at once. Roster pages after
the first are fetched in parallel, as are the customer-detail requests inside
each batch, so the first CSV file lands far sooner on a large store. The
default is 1, which keeps every request sequential.

Concurrency does not raise the request rate. `--request-delay-ms` stays a
global cap across all in-flight requests: at 250 milliseconds the exporter
still starts at most four requests per second whether concurrency is 1 or 8.
Raising concurrency hides network latency rather than sending more traffic. The
manifest saves the setting, and `--resume` reuses it unless you pass a new
`--concurrency`. It is the one saved setting resume lets you change, because it
cannot alter the request rate. The real ceiling is your BigCommerce plan's API
quota: past it the store returns 429 and the retry backs off to the quota rate.

```text
exports/customer-migration-v1/
├── manifest.json          settings + mapping, written once
├── customer-ids.jsonl     the frozen customer IDs, written once
├── progress.json          next batch + missing IDs, written per batch
├── customer-migration-v1-000001.csv
├── customer-migration-v1-000002.csv
└── .state/
```

The frozen ID list lives in `customer-ids.jsonl` rather than inside
`manifest.json`, so finishing a batch rewrites only the few hundred bytes of
`progress.json`. On a three-million-customer export that is the difference
between about 108 GB and about 200 KB of progress writes. A manifest saved by
an older version is split into these three files the first time you `--resume`
it.

Use `--limit` to test the mapping before the full export. This command writes
100 customers across four files:

```sh
bcli export customers customer-sample-v1 \
  --all \
  --limit 100 \
  --batch-size 25 \
  --columns-file mappings/customer-migration.json \
  --export
```

If an export stops, resume it with the same key:

```sh
bcli export customers customer-migration-v1 --resume --export
```

While the roster is still being collected, the run directory holds
`roster-checkpoint.json` and `roster-ids.jsonl`. After the roster is frozen,
the manifest stores the customer IDs, the mapping, and the first incomplete
batch. Resume continues an unfinished roster, then skips completed batches and
reuses generated UUIDs.

An export key cannot overwrite an existing export. To run the export again
with new data or a changed mapping, use a new key such as
`customer-migration-v2`. If you omit `--export`, the command performs a dry run
and does not create CSV files.

To include BigCommerce timestamps, add these columns to the mapping file:

```json
{ "header": "createdAt", "source": "date_created" },
{ "header": "updatedAt", "source": "date_modified" }
```

### 3. Environments

Work against multiple stores (sandbox, staging, production) from the same machine. Each `bcli setup --env <name>` run creates a separate `~/.bcli/<name>.env` file.

```sh
bcli setup --env production      # create another env
bcli env list                    # list all envs (marks the active one)
bcli env use production          # switch — verifies credentials against the API
bcli env show                    # inspect the active env (token masked)
bcli env remove old-sandbox      # delete an env
```

The active env is persisted on disk, so every subsequent command (`get`, `export`, `check`, …) runs against it until you `env use` something else.

### 4. MCP

Two ways to register bcli with your agent (Claude Code, Cursor, etc.).

**Option A — auto-register** (recommended):

```sh
bcli mcp add        # auto-register
bcli --mcp          # run as stdio MCP server
```

This writes the entry to your agent's MCP config for you. Then restart the agent.

**Option B — edit the config manually.** Open `~/.claude.json` (or your agent's equivalent) and add:

```json
{
  "mcpServers": {
    "bcli": { "command": "bcli", "args": ["--mcp"] }
  }
}
```

Restart your agent. The `bcli` command must be on your `PATH` (i.e. installed globally) — using the binary name rather than an absolute path keeps the entry stable across version upgrades.

To run it standalone for debugging:

```sh
bcli --mcp          # stdio MCP server
```

## Commands

| Command                             | Description                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `setup`                             | Interactive setup — store env + form-fields registry                             |
| `env list`                          | List available environments                                                      |
| `env use <name>`                    | Switch to an environment                                                         |
| `env show`                          | Show current environment details                                                 |
| `env remove <name>`                 | Remove an environment                                                            |
| `check connection`                  | Test API connection and show store info                                          |
| `check version`                     | Compare installed bcli version against latest on npm                             |
| `export customers <key>`            | Export filtered or all customers to CSV, with retryable batch support            |
| `get customer <email>`              | Look up a customer by email                                                      |
| `get order <id>`                    | Get order details by ID                                                          |
| `get orders --email <email>`        | Query orders by customer email                                                   |
| `get cart <id>`                     | Inspect a cart by cart ID or order ID                                            |
| `get fees <orderId>`                | Get fees for an order                                                            |
| `get form-fields`                   | Discover customer form fields, attributes, and sample data                       |
| `get search`                        | Search customers with filters (email, name, phone, company, dates, IP, order ID) |
| `update form-field <id> <name> <v>` | Update a single form field value for a customer                                  |
| `clean progress <key>`              | Remove the progress file for an export key                                       |

Run `bcli <command> --help` for full flags on any command.

## Global Flags

| Flag              | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `-v`, `--verbose` | Detailed per-page, per-batch, and per-customer logging                   |
| `--format <fmt>`  | Output format (`toon`, `json`, `yaml`, `md`, `jsonl`)                    |
| `--json`          | Shorthand for `--format json`                                            |
| `--config <path>` | Load option defaults from a JSON file (`~/.bcli/config.json` by default) |
| `--no-config`     | Disable the auto-loaded config file                                      |

## License

BUSL-1.1
