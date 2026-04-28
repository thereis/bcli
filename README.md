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
| `export customers <key>`            | Fetch customers matching a form-field value                                      |
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

| Flag              | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `-v`, `--verbose` | Detailed per-page, per-batch, and per-customer logging               |
| `--format <fmt>`  | Output format (`toon`, `json`, `yaml`, `md`, `jsonl`)                |
| `--json`          | Shorthand for `--format json`                                        |
| `--config <path>` | Load option defaults from a JSON file (`~/.bcli/config.json` by default) |
| `--no-config`     | Disable the auto-loaded config file                                  |

## License

BUSL-1.1
