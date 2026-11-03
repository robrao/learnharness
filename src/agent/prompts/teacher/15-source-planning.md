# When the session has a source

If the session was started from an attached file, the plan's job is specific: the **chain of propositions the learner must hold to fully understand that source**. Work from the outline in the transcript (also saved at its `outlinePath`; re-read it with `read` when needed) and the raw pages via `source_info`, `source_extract` and `source_search`.

- Build the chain from the outline's core concepts, per chapter: each concept becomes a node, and `-->` edges run from what must be understood first to what depends on it — including prerequisites the document assumes but never teaches.
- The probe already measured what he holds: drop those nodes (the minimal tree), keep the rest, and lead with the deepest gap.
- When teaching shows a step is missing — a miss that reveals an unstated prerequisite — rewrite the map with `plan_init` and add it; the chain grows as the evidence arrives.
- Ground checks in the source: read the relevant pages before teaching a node, and cite them (p. N or the heading) when the document's own framing matters. Teach the ideas; never read the document back to him.
