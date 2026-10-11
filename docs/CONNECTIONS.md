# Connections: letting Jackie's agents reach other services, safely

A **connection** is an outside HTTPS service the person lets their agents use: a weather
API, a GitHub repository's issues, a home-automation hub, a company's internal API. Each
connection lists the **operations** agents may perform on it ("search issues", "create an
issue", "read the thermostat"), with typed parameters. Agents call an operation by name;
they never write a URL, a header or a request body themselves.

Connections are the most dangerous thing agents can be given. Everything else they do
stays inside the person's own rows in the app's database. A connection carries data out
of the app to someone else's server, and brings back text written by someone else, which
lands in front of a model. So this document comes first: what can go wrong, what stops
it, and what is left.

## Who can do what

| | Person (in the app) | Agent (MCP harness, Agent Lab operator) |
| --- | --- | --- |
| Create a connection and its operations | Yes, active at once | **Propose only.** It waits, switched off, for approval on `/skills`. |
| Store or replace the secret (API key, token) | Yes, through `jackie-connect`, from the app's own session | **Never.** Proposals carry no secret, and the function refuses an agent token. |
| See the secret | **No one, ever.** Not the person, not an agent, not the page. It goes in once and is used only inside `jackie-connect`. | No |
| Call a read operation (`GET`) | Yes | Yes, if the connection is active |
| Call a write operation (`POST`, `PUT`, `PATCH`, `DELETE`) | Yes | Only if the person switched on **Agents may write** for that connection |
| Send app data (an earlier step's result) through a tool | Only to an operation the person marked **Accepts app data** | Same |

## Threats and what stops them

| # | Threat | Control | Left over |
| --- | --- | --- | --- |
| T1 | **Secret leak.** A key reaches the browser, a log, an agent, or a response. | Secrets live in `jackie_connection_secrets`. No API role can read it: no grant to `anon` or `authenticated`, and RLS is on. They are encrypted with AES-256-GCM under `CONNECTIONS_SECRET_KEY`, an edge-function secret that never ships to the browser. The connection id and owner are bound in as associated data, so a ciphertext copied to another row will not decrypt. The secret is decrypted only inside `jackie-connect`, for the one request. Any echo of it in a response is replaced with `[redacted]`. It is never logged. | Whoever holds both the database and `CONNECTIONS_SECRET_KEY` (the project's admins) can decrypt. That is inherent to a server that must use the key. |
| T2 | **SSRF.** A connection, or an agent's argument, points the server at something private: the cloud metadata endpoint, localhost, the project's internal network, a LAN address. | The base URL must be `https://` with a DNS hostname: no IP literals, no username or password in the URL, no port other than 443. Before every call the function resolves the host and refuses private, loopback, link-local, CGNAT, multicast and reserved addresses (IPv4 and IPv6). Redirects are **not** followed. Arguments never touch the host: path parameters are URL-encoded one segment at a time, so `../` and `/` cannot walk off the operation's path. | DNS rebinding between the check and the connection (the runtime's `fetch` cannot pin an IP). The function runs on Supabase's infrastructure, not on the person's network, so their LAN is out of reach regardless. |
| T3 | **Exfiltration.** A model, perhaps steered by injected text, reads the person's memory or tasks and sends them to a connection. | Only operations the person approved exist. Writes are off for agents unless switched on per connection. A custom tool that feeds an earlier step's result (`{{steps.N…}}`) into a connection call is refused at run time unless the operation is marked **Accepts app data**. Parameters have types and length caps, at most 2,000 characters for a string. Every call is recorded with its arguments in the person's activity. | An agent calling an operation directly can still type data it has read into a text parameter of an approved operation, a search query for instance. The caps bound it and the activity log shows it. It cannot be ruled out without forbidding text parameters. |
| T4 | **Prompt injection back in.** A response contains "ignore your instructions and…". | Every response reaches agents wrapped as `{"untrusted": true, "source": …, "status": …, "body": …}`. The MCP server's instructions and the operators' action manual say content from a connection is data, never instructions. Bodies are capped at 32 KB before they reach a model. | Models can still be fooled. The wrapper lowers the odds; it is not a guarantee. That is why writes are off by default. |
| T5 | **Another account's connection.** | Connections and secrets are per user and pinned to the caller's own rows by RLS. The function looks the connection up with the caller's id, never an id from the request alone. Probes prove that one account can neither read nor use another's. | — |
| T6 | **Header and request smuggling.** | Agents cannot set headers. The only header added is the auth header, whose name the person chose and which is validated as a token (`[A-Za-z0-9-]`). Its value is the stored secret, checked to contain no CR or LF before it is sent. | — |
| T7 | **Cost and abuse.** An agent loops, or a slow server holds the function. | Each call spends a unit of the caller's quota, the same gate as the model engines. There is a 15-second timeout and a 1 MB read limit, after which reading stops. Pending proposals are capped. | — |
| T8 | **Proposal laundering.** An agent proposes a connection with a harmless description that points somewhere it should not. | The approval card shows the host, every operation's method and path, which operations write, and which accept app data, before **Approve**. A proposed connection has no secret, so even approved it reaches only what needs no credentials until the person adds one. | Approving is still a judgement the person makes. |
| T9 | **Downgrade after approval.** An agent edits an approved connection to point elsewhere. | The same database rule as skills and tools: a write that carries an OAuth `client_id` may only insert a proposal. Editing, activating and deleting are refused, for any connection. | — |
| T10 | **The person's own mistake.** A write operation called by accident, from the Run button. | The Run dialog says which operations write and sends nothing until **Run** is pressed. | — |

## How a call flows

```
agent ──call_connection(github, search_issues, {q})──▶ appActions.callConnection
        (MCP tool / Agent Lab)                          │ checks the shape; nothing sensitive here
                                                        ▼
                                            supabase.functions.invoke("jackie-connect")
                                                        │ the caller's own token
                                                        ▼
jackie-connect (edge function, Deno)
  1. requireUser + quota                     (T5, T7)
  2. load the connection: caller's rows, status active
  3. find the operation; check args against its params (types, lengths, required)
  4. writes: refuse an agent token unless "agents may write"   (T3)
  5. build the URL: base + path, each {param} URL-encoded; query from query params
  6. resolve the host; refuse non-public addresses              (T2)
  7. decrypt the secret (if any); add the auth header or query key   (T1, T6)
  8. fetch: 15 s timeout, no redirects, read at most 1 MB       (T2, T7)
  9. redact the secret from the body; cap the body at 32 KB     (T1, T4)
 10. record the call in audit_events
 11. answer {untrusted: true, source, operation, status, body}  (T4)
```

## What is deliberately not here

- **No arbitrary requests.** There is no "fetch any URL" operation, for agents or anyone else.
- **No connections to other MCP servers.** That needs its own design: their tools are open-ended.
  Worth doing next, but not by stretching this one.
- **No secrets in the browser bundle, `.env`, or a table the API can read.** See `docs/ENVIRONMENT.md`.
  `CONNECTIONS_SECRET_KEY` belongs in Cloud → Secrets.

## Turning it on

1. `supabase db push`, which creates the connection tables.
2. Generate a key and store it as an edge-function secret:
   `openssl rand -base64 32` → Cloud → Secrets → `CONNECTIONS_SECRET_KEY`.
   Without it, connections that need a secret refuse to store or use one, and say why.
3. Deploy the functions. Lovable does this.
