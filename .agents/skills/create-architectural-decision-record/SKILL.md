---
name: create-architectural-decision-record
description: Create a repository-local Architectural Decision Record (ADR) when the user wants to document a cross-spec or long-lived architecture decision, its context, alternatives, consequences, and implementation constraints.
---

# Create Architectural Decision Record

Create one ADR from facts in the conversation and repository. Keep product behavior in its Spec; use the ADR only for a cross-spec or long-lived architecture decision.

## 1. Validate Inputs

Confirm the decision title, context, selected decision, and considered alternatives from the conversation and repository sources. If a required fact is unknown or conflicting, ask for that fact before writing; do not invent it.

## 2. Allocate the ADR Path

1. Resolve the repository root from the current worktree.
2. Create `<repository-root>/docs/adr/` when it does not exist.
3. Inspect existing `adr-NNNN-*.md` files, choose the next number after the highest existing number, and increment again if the target path already exists.
4. Build a lowercase hyphenated title slug and write `docs/adr/adr-NNNN-<title-slug>.md` relative to the repository root.

Never resolve the destination as the filesystem-root path `/docs/adr/`.

## 3. Write the ADR

Use [ADR template](assets/adr-template.md) as the output structure. Replace every template token with verified content and remove optional fields or sections that are genuinely not applicable instead of leaving empty values.

- Record the date and use one status: `Proposed`, `Accepted`, `Rejected`, `Superseded`, or `Deprecated`.
- State the decision and why it was selected.
- Include at least one positive and one negative consequence.
- Describe each considered alternative and its rejection reason.
- Use unique three-letter, three-digit IDs for multi-item sections.
- Link the Spec, ADR, source, or external reference that supports a factual dependency.

## 4. Validate the Result

Before reporting completion:

- confirm the path is inside the current repository;
- confirm no `{{...}}` template tokens remain;
- confirm the decision, alternatives, consequences, and references agree with the verified inputs;
- confirm coded item IDs are unique;
- run the repository's applicable Markdown check and `git diff --check -- <adr-path>`.

Report the created repository-relative path and any fact that remains unverified.
