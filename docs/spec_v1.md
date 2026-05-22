# Build: Team Gmail Assistant — a multi-account Gmail MCP server

> **Note for public readers:** this document is the original
> behavior specification — the plain-language, specification-first
> prompt the operator handed to the building agent at the very
> start of the project, then froze as a contract. It is in the
> spirit of BDD (behavior-first, user-perspective, "what not how"),
> but not the formal practice: no Gherkin, no Cucumber, no
> executable specs wired to tests, no three-amigos workshop. The
> second-person voice ("you decide everything about *how*", "do not
> hand me technical steps") is intentional — it shows how the scope
> was set. The neutral technical design that fell out of this
> conversation is in [proposal_v1.md](proposal_v1.md); the live
> operator/teammate/runbook docs are the build's current state.

## What this is

Build a hosted Gmail MCP (Model Context Protocol) server that lets a small, fixed team operate their Gmail inboxes through an AI assistant like Claude. One technical operator sets it up once; each non-technical teammate then connects their own Gmail accounts by clicking "Sign in with Google," and from then on can search, read, draft, send, and organize their mail by asking their assistant in plain language.

The problem it solves: the default Gmail connector binds an assistant to a single Google account, so someone who runs their work across several inboxes can't get a complete answer to "did anything important arrive today?" without checking each inbox by hand. This server fixes that.

It serves **one team** — the operator's own team of roughly four people, all in one Google Workspace organization. It is not a service for outside customers.

## How we're working together

We are building this with a **behavior-first, specification-first** approach — in the spirit of BDD, but not the formal practice (no Gherkin, no Cucumber, no executable specs, no three-amigos workshop). I describe *what* the product must do from the user's point of view and freeze that as a contract; you decide everything about *how* — stack, architecture, libraries, storage, project structure, identity mechanism, all of it. When something is underspecified, choose the simplest option consistent with the behaviors and constraints below, and tell me what you chose and why.

## What I will do (and only this)

I am the operator — technical, but I want to stay out of implementation decisions. I will:

1. Paste prompts to you and answer your questions.
2. Log into Cloudflare when you tell me to.
3. Provide my Google app `credentials.json` (OAuth client ID + secret) when you ask.
4. Log into multiple Gmail accounts from our Google Workspace to test, or use whitelisted test-mode accounts. **The Google app stays in test mode — no verification or audit — so design for the test-user allowlist.**
5. Run deploy commands you give me to push to a Cloudflare Worker on the **free tier**.

Everything else is yours. Do not hand me technical steps outside that list. If a step would force me outside it, stop and explain rather than working around it.

## Working norms

- **Create and use a virtual environment** if your chosen toolchain needs one, to keep the workspace clean.
- **Initialize a git repo** in the project directory if one doesn't exist. You work in a local repo only — no remote is configured and none will be granted, so do not attempt to push, add remotes, or access GitHub for our repo.
- **Follow version-control best practices.** Commit in small, meaningful, self-contained increments as you make progress — each commit one coherent step that builds and makes sense on its own. Write clear, descriptive commit messages. Keep secrets, credentials, `credentials.json`, tokens, and build artifacts out of version control via `.gitignore`. Never commit anything sensitive.
- You may **search the web** and **clone up to 5 GitHub repositories** to evaluate as foundations or inspiration — Cloudflare MCP-on-Workers templates, Gmail MCP servers, multi-account Gmail MCP servers. Prefer reputable, recently-maintained repos. **Tell me which repos you cloned, what you took from each, and check their licenses before reusing code.** Keep clones in a scratch directory outside the project, or `.gitignore` them — don't commit other people's repos into ours.
I also evaluated `mcp-server-trello` (a multi-account Trello MCP server)
as a structural reference — it has a similar shape (per-user credentials,
nicknamed connections, isolation by user ID) and informed some early
naming and layout decisions.

## Behaviors the product must have

Write these up as a plain-language behavior list — numbered, readable by a non-technical person, each a concrete statement of what happens from the teammate's point of view ("When a teammate asks X, the assistant does Y"). Then build it.

**Connecting accounts**
- A non-technical teammate connects a Gmail inbox by clicking "Sign in with Google" and nothing else — no developer setup, no credentials, no configuration, no terminal. After the operator's one-time setup, a teammate never needs a technical step.
- A teammate gives each connected inbox a short nickname.
- A teammate can connect several of their own inboxes, list the ones they've connected, and disconnect one.
- Connected inboxes, their nicknames, their sign-in credentials, and the record of which teammate owns which inbox all persist in server-side managed storage — never on a teammate's device — and survive restarts and device changes.

**Reading and searching**
- The assistant can search and read mail within one named inbox: find a specific message, list results, read a full thread.
- A single request can span several of a teammate's inboxes at once and return one unified answer, with every result clearly labelled by which inbox it came from. "Did I get anything important today?" is one complete answer drawn from all their inboxes — not one answer per inbox.
- A teammate never has to think about which inbox is "currently connected" — all of theirs always are.

**Composing and organizing**
- The assistant can draft a reply, send mail, and manage labels within a named inbox.
- The assistant always knows, names explicitly, and shows the teammate which inbox an answer came from and which inbox a message will be sent from. There is no silent confusion between accounts and the assistant never sends from the wrong identity.
- Sending mail is always a deliberate, explicit action with an explicitly named sending inbox. Reading and searching are the everyday default. Nothing sends mail as a side effect of another operation.

**Feature parity**
- Match the capabilities of a best-in-class *single-account* Gmail MCP server — search, read threads, draft, send, label management — and layer the multi-account behaviors above on top.

**Whole-product success**
- After the operator's one-time setup, a non-technical teammate can connect their inboxes in a few minutes having only clicked "Sign in with Google" and typed short nicknames.
- The same assistant works identically on phone, laptop, and web browser, because the product lives on a server and follows the teammate across devices.

## Hard constraints — do not violate

- **Hosted on Cloudflare's serverless platform.** Nothing runs on a teammate's machine. Design for short-lived, stateless request handling with persistence and credentials held by managed services. Stay within free-tier per-request limits on running time, memory, and response size — the heaviest operation the product performs must fit comfortably within them.
- **All durable state lives on the server**, never on a teammate's device — connected inboxes, nicknames, credentials, and ownership records.
- **Strict per-teammate isolation on one shared server.** The whole team shares one server, but each teammate's inboxes are private to that teammate. No request from one teammate may ever read or act on another teammate's mail. The identity of the teammate making each request must be established reliably before any inbox is touched.
- **Access restricted to the operator's Google Workspace organization.** People outside the team cannot connect.
- **Sign-in credentials encrypted at rest** in managed storage.
- **Minimum necessary Gmail permissions** — only reading, searching, composing and sending, and label management. No broader account access.
- **No background operation, no self-scheduling.** The server never acts on its own clock — it responds only when an assistant calls it. No unprompted timed briefings.
- **Gmail only.** No Outlook, no generic IMAP.
- **Email only.** No Calendar, Drive, or other Google services.
- **Not a multi-tenant service for outside customers.** One team, that team's own inboxes. Never hold credentials of unrelated customers on one deployment.

## How to start

Do not write code yet. First:

1. Confirm your understanding back to me in a few sentences — especially anything ambiguous.
2. **Propose the full tech stack, project structure, and storage approach**, with brief justification. You own this decision; I just want to see it.
3. **Propose the per-teammate identity mechanism** — how the server reliably knows which teammate is making each request, satisfying strict isolation *and* the no-technical-onboarding rule. Explain the tradeoff and recommend one.
4. List the GitHub repos you intend to evaluate.
5. Show me the plain-language behavior list.

Then stop and wait for my approval before writing code. After approval, build in meaningful increments, committing as you go.

