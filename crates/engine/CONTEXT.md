# Workflow engine

The Workflow engine (proteusd) is the meta-harness that runs Workflows (ordered sequences of agent skills) against a project, either Gate-by-Gate with the user or on Autopilot.

## Workflows

**Workflow**:
A named, declarative sequence of Stages that turns one kind of request into one kind of outcome (e.g. New feature, Bug fix).
_Avoid_: pipeline, playbook, flow

**Workflow Pack**:
The installable plugin unit: one or more Workflows plus the skills they reference.
_Avoid_: plugin, bundle, skill pack

**Stage**:
One step of a Workflow, carried out by one or more Sessions using a fixed set of skills, ending at a Gate.
_Avoid_: phase, step

**Gate**:
The checkpoint ending a Stage, where its output is accepted and the next Stage is chosen.
_Avoid_: approval, checkpoint

**Branch Decision**:
A choice between alternative or optional Stages, proposed by the preceding Stage's output and overridable at its Gate.

**Intake**:
The opening Stage of every WorkOrder: it gathers the request and proposes a Workflow. Its Gate is always passed by a human, even on Autopilot.
_Avoid_: router, triage (triage is a skill)

**Autopilot**:
The mode in which Gates pass without the user and agents answer their own questions, pausing only on blocking uncertainty.
_Avoid_: auto mode, yolo

**Assumption**:
An answer an agent gave itself on Autopilot instead of asking the user, recorded so the user can review it.

**Answerer**:
On Autopilot, the Session that answers an interactive skill's questions in the user's place and escalates blocking uncertainty to the user.
_Avoid_: auto-responder, proxy user

## Execution

**WorkOrder**:
One execution of a Workflow for one user request.
_Avoid_: job, workflow run

**Session**:
One agent conversation; a GUI Session (see `gui/CONTEXT.md`) that proteusd spawns and drives.
_Avoid_: thread, chat

**Run**:
A Session that executes exactly one Ticket.
_Avoid_: attempt, task

**Brief**:
The self-contained opening message of a fresh Session: the full text of what it needs (Ticket, Spec, prior Stage output) rather than pointers.
_Avoid_: handoff, context

**Integration Branch**:
The WorkOrder's branch that every Run merges back into.

**Frontier**:
The Tickets whose blockers have all landed, so they are ready to Run.
_Avoid_: ready set, queue

**Landing**:
A Run's commits merging into the Integration Branch, which happens only after the project's verify commands pass on the merged result.
_Avoid_: merge, completion

**Repair Run**:
A Run started to fix a failed verify or merge conflict from an earlier Run of the same Ticket. Bounded in number before escalating.
_Avoid_: retry, fixup

## Tracker

**Tracker**:
The store of a WorkOrder's Specs, Tickets and Review findings. Its backend is either Local markdown kept by proteus or the project's GitHub Issues.
_Avoid_: issue tracker, backlog

**Spec**:
The agreed description of what a WorkOrder will deliver.
_Avoid_: PRD, plan

**Ticket**:
One independently implementable slice of a Spec, with blocking edges to other Tickets.
_Avoid_: issue, task

**Ticket Graph**:
A Spec's Tickets together with their blocking edges.
_Avoid_: DAG, plan

**Map**:
The Ticket Graph of decision Tickets (research, prototype, grilling, task) that charts a Large initiative before its Spec exists.
_Avoid_: roadmap, plan
