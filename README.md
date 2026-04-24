# BigCommerce CLI (bcli)

A CLI for BigCommerce — search customers, export filtered data to CSV, look up orders, and manage multi-store environments. Exports are **config-driven**: you register the custom form fields your store uses, then run generic `export customers` commands against them. Built with [incur](https://github.com/wevm/incur) and [Bun](https://bun.sh).

## Install

```sh
git clone <repo-url> && cd bcli
pnpm install
```

To make the `bcli` command available globally:

```sh
pnpm run build
pnpm link --global
```

## Setup

```sh
pnpm bcli setup
```

The wizard prompts for:

1. **Store hash + API access token** (required)
2. **Pretty logging** (optional)
3. **Custom form fields** (optional) — choose:
   - **fetch** — pulls the form-field catalog from your BigCommerce store via `/v3/customers/form-fields` and lets you pick which ones to register (`1,3,5`, `1-4`, or `all`). Types are auto-mapped from the BigCommerce definition.
   - **manual** — type in each field name + type yourself.
   - **skip** / **keep** — leave the registry alone.

Credentials go to `.bc/<env>.env`. Form fields go to `.bc/form-fields.json`. Both are gitignored.

Run `pnpm bcli setup --env production` to create additional environments.

## Environment Variables

| Variable          | Required | Default | Description                  |
| ----------------- | -------- | ------- | ---------------------------- |
| `BC_STORE_HASH`   | yes      |         | BigCommerce store hash       |
| `BC_ACCESS_TOKEN` | yes      |         | BigCommerce API access token |
| `LOG_PRETTY`      | no       | `false` | Pretty-printed logs          |

## Form Fields Registry

Custom form-field definitions live in `.bc/form-fields.json` (gitignored). The CLI uses this list to validate `--field` arguments on `export customers`.

```json
{
  "formFields": [
    { "name": "Full due diligence is complete", "type": "boolean" },
    { "name": "Phone verified", "type": "boolean" }
  ]
}
```

You can edit this file directly, or re-run `pnpm bcli setup` and choose `replace` when asked about form fields. To discover what's defined on your store:

```sh
pnpm bcli get form-fields
```

## Commands

Commands are organized by verb: `export`, `get`, `update`, `check`, `clean`, `env`, plus top-level `setup`.

| Command                             | Description                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `setup`                             | Interactive setup — store env + form-fields registry                             |
| `env list`                          | List available environments                                                      |
| `env use <name>`                    | Switch to an environment                                                         |
| `env show`                          | Show current environment details                                                 |
| `env remove <name>`                 | Remove an environment                                                            |
| `check connection`                  | Test API connection and show store info                                          |
| `export customers <key>`            | Fetch customers matching a form-field value (see flags below)                    |
| `get customer <email>`              | Look up a customer by email                                                      |
| `get order <id>`                    | Get order details by ID                                                          |
| `get orders --email <email>`        | Query orders by customer email                                                   |
| `get cart <id>`                     | Inspect a cart by cart ID or order ID                                            |
| `get fees <orderId>`                | Get fees for an order                                                            |
| `get form-fields`                   | Discover customer form fields, attributes, and sample data                       |
| `get search`                        | Search customers with filters (email, name, phone, company, dates, IP, order ID) |
| `update form-field <id> <name> <v>` | Update a single form field value for a customer                                  |
| `clean progress <key>`              | Remove the progress file for an export key                                       |

### `export customers` flags

| Flag                 | Short | Description                                                             |
| -------------------- | ----- | ----------------------------------------------------------------------- |
| `<key>` (positional) |       | Short identifier used for the progress file and default output prefix   |
| `--field <name>`     |       | Form field name to match (must be registered in `.bc/form-fields.json`) |
| `--value <v>`        |       | Form field value to match (e.g. `True`)                                 |
| `--columns <spec>`   |       | Column spec for the clean export CSV (see syntax below)                 |
| `--full-columns`     |       | Column spec for the base file (defaults to `Customer ID:id, <columns>`) |
| `--output-prefix`    |       | Output file prefix (defaults to slugified `<key>`)                      |
| `--export`           | `-e`  | Write results to `exports/<prefix>_<date>.csv`                          |
| `--resume`           | `-r`  | Resume from last saved progress                                         |
| `--incremental`      | `-i`  | Only fetch customers not in the base export                             |

### Column spec syntax

`--columns "Name:source,Name:source,..."`

| Source                 | Resolves to                              |
| ---------------------- | ---------------------------------------- |
| `id`                   | `customer.id`                            |
| `email`                | `customer.email`                         |
| `phone`                | `customer.phone`                         |
| `first_name`           | `customer.first_name`                    |
| `last_name`            | `customer.last_name`                     |
| `date_created`         | `customer.date_created`                  |
| `date_modified`        | `customer.date_modified`                 |
| `company`              | `customer.company`                       |
| `addresses[N].<field>` | `customer.addresses[N].<field>`          |
| `form_field:<name>`    | The value of the named custom form field |

Column names cannot contain `,` or `:`.

### Global Flags

| Flag              | Short | Description                                                              |
| ----------------- | ----- | ------------------------------------------------------------------------ |
| `-v`              |       | Enable detailed per-page, per-batch, and per-customer logging            |
| `--format <fmt>`  |       | Output format (`toon`, `json`, `yaml`, `md`, `jsonl`). Default: `json`.  |
| `--json`          |       | Shorthand for `--format json`                                            |
| `--config <path>` |       | Load option defaults from a JSON file (see **Config file** below)        |
| `--no-config`     |       | Disable the auto-loaded config file for this run                         |
| `--verbose`       |       | Include incur's full response envelope (`ok` / `data` / `meta`)          |

### Config file

Persist per-command option defaults in `.bc/config.json` (project) or `~/.config/bcli/config.json` (global). First match wins; argv still overrides. Options nest under the command path:

```json
{
  "commands": {
    "get": {
      "commands": {
        "orders": {
          "options": { "limit": 25 }
        }
      }
    }
  }
}
```

Only command **options** are loaded — positional args, `env` vars, and global flags (including `--format`) are not configurable this way.

### Call-to-actions (CTAs)

Every command returns suggested next commands in its response envelope under `cta.commands`. Agents can chain without extra prompting:

```sh
bcli get order 12345
# → { ...order, cta: { commands: [
#     { command: "bcli get fees 12345", description: "View fees for this order" },
#     ...
# ] } }
```

### Usage Examples

```sh
# Look up a customer
pnpm bcli get customer user@example.com

# Get order details or customer orders
pnpm bcli get order 12345
pnpm bcli get orders --email user@example.com

# Ad-hoc search
pnpm bcli get search --email user@example.com

# Export customers matching a form field (assumes the field is registered)
pnpm bcli export customers fdd \
  --field "Full due diligence is complete" \
  --value "True" \
  --columns "Email address:email,Country:addresses[0].country" \
  --export

# Incremental run (only new customers since last export)
pnpm bcli export customers fdd \
  --field "Full due diligence is complete" --value "True" \
  --columns "Email address:email,Country:addresses[0].country" \
  --export --incremental

# Clean up the progress file for the "fdd" key
pnpm bcli clean progress fdd

# Environments
pnpm bcli env list
pnpm bcli env use production
```

Tip: wrap repeated exports in shell aliases or an npm script so you don't type the flags each time.

## How `export customers` works

The command is a two-phase pipeline with a resumable progress file.

### Phase 1 — collect matching IDs

1. `--field` is validated against `.bc/form-fields.json`. If the registered field has `options`, `--value` is validated too.
2. Paginate through `/v3/customers/form-field-values?field_name=<field>` (250 per page, cursor-paginated).
3. For each entry where `value === <--value>`, collect the `customer_id`.
4. After every page, the cursor + collected IDs are written to `.progress-<key>.json`.

### Phase 2 — fetch customer details

1. Customer IDs are batched at 50 per request (BigCommerce's `id:in` ceiling) and fetched from `/v3/customers?id:in=...&include=addresses,formfields`.
2. For each returned customer, columns are resolved via the `--columns` spec and a row is appended to:
   - `exports/<prefix>.csv` — **base file** (always prepends `Customer ID:id` so later incremental runs can dedupe).
   - `exports/<prefix>_<YYYY-MM-DD>.csv` — **clean file** (just the columns you specified; this is what you hand off for import).
3. `processedIdIndex` is saved to the progress file after each batch.
4. On success, the progress file is removed.

Both CSVs are written as the stream progresses, so an interrupted run never loses data — just re-run with `--resume`.

### Dry run

Omit `--export` to skip Phase 2's file writes. You still get the match count and ID list in logs, which is useful for previewing how many rows an export will produce before committing to it.

```sh
pnpm bcli export customers trusted --field "Is trusted customer" --value "True" --columns "Email:email"
# → "Found N customers with Is trusted customer = True"
```

### Resume (`--resume` / `-r`)

If the process dies mid-run (network hiccup, Ctrl-C, rate limit), re-invoke with the same `<key>` plus `--resume`. The progress file is loaded and:

- If interrupted during Phase 1, pagination picks up from the saved cursor.
- If interrupted during Phase 2, batch fetching resumes from `processedIdIndex`.

Without `--resume`, the CLI deletes the stale progress file and starts fresh.

### Incremental (`--incremental` / `-i`)

Only useful when you've already run a full export at least once (so a base `exports/<prefix>.csv` exists).

- Reads the `Customer ID` column from the base file into a set.
- Subtracts those IDs from Phase 1's match list.
- Only the **new** customers are fetched in Phase 2.
- Output filename gets an `-incremental` suffix so you can distinguish deltas.

This turns a daily re-run from "fetch everything" into "fetch only customers who newly matched since yesterday" — typically 100× faster on mature stores.

### Performance notes

| Concern               | How it's handled                                                                     |
| --------------------- | ------------------------------------------------------------------------------------ |
| Form-field pagination | Cursor-based, 250/page — maximum allowed.                                            |
| Customer fetch        | Batched at 50 IDs/request, parallelism = 1 (keeps you well under BC's rate limits).  |
| Memory                | IDs held in memory, customers streamed to disk one-by-one. Fine for 100k+ customers. |
| Rate limits           | Uses `got`'s retry (HTTP 429 → exponential backoff). See `src/lib/bigcommerce/bc-http.ts`.       |
| Crash recovery        | Progress persisted after each page and each batch → `--resume` is lossless.          |
| Duplicate work        | `--incremental` diffs against the base CSV's `Customer ID` column.                   |

### Progress file

Lives at the project root as `.progress-<slug(key)>.json` (gitignored):

```json
{
  "cursor": "opaque-cursor-string",
  "pageNum": 4,
  "collectedIds": [1, 2, 3, ...],
  "processedIdIndex": 50
}
```

- `cursor` / `pageNum` — Phase 1 state
- `collectedIds` — full list once Phase 1 completes
- `processedIdIndex` — Phase 2 pointer (how many IDs already written)

Manually clear with `pnpm bcli clean progress <key>`.

## Shell Completions

`incur` provides built-in shell completions for bash, zsh, fish, and nushell.

```sh
eval "$(bcli completions bash)"    # bash → ~/.bashrc
eval "$(bcli completions zsh)"     # zsh  → ~/.zshrc
bcli completions fish | source     # fish → ~/.config/fish/config.fish
```

## MCP Server

This CLI can run as an MCP (Model Context Protocol) server, exposing all commands as tools for AI agents like Claude Code or Cursor.

```sh
bun src/cli.ts mcp add      # register with your agent
bun src/cli.ts --mcp        # run as stdio server
```

Manual agent config:

```json
{
  "mcpServers": {
    "bcli": {
      "command": "bun",
      "args": ["<path-to-project>/src/cli.ts", "--mcp"]
    }
  }
}
```

## Project Structure

Handlers are organised by domain (customer, order, cart, store, progress) under `commands/handlers/`. The top-level files in `commands/` are verb groups (`export`, `get`, `update`, `check`, `clean`, `env`, `setup`) that wire domain handlers into CLI subcommands.

```
src/
  cli.ts                             # entry point
  commands/
    export.ts  get.ts  update.ts     # verb groups (wire subcommands)
    check.ts   clean.ts  env.ts
    setup.ts
    handlers/
      customer/
        get-customer.ts              # get customer <email>
        get-search.ts                # get search
        export-customers.ts          # export customers <key>
        update-form-field.ts         # update form-field
      order/
        get-order.ts                 # get order <id>
        get-orders.ts                # get orders --email
        get-fees.ts                  # get fees <orderId>
      cart/
        get-cart.ts                  # get cart <id>
      store/
        check-connection.ts          # check connection
        get-form-fields.ts           # get form-fields
      progress/
        clean-progress.ts            # clean progress <key>
        get-progress.ts              # get progress [<key>]
  lib/                               # shared utilities (API client, schemas, env,
                                     #   form-fields, column-spec, logger)
exports/                             # CSV output (gitignored)
.bc/                                 # environment configs + form-fields registry (gitignored)
```
