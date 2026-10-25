# Autopilot answers interactive skills with an Answerer Session

Interactive skills (grilling, to-tickets, tdd, triage) run unmodified on Autopilot. When a Session's turn settles without its completion call, proteus forwards the question to the WorkOrder's single Answerer Session. That Session is persistent and read-only, and sees the request, GLOSSARY, ADRs and prior Assumptions. It replies with either an answer, which is logged as an Assumption and sent back as the user's reply, or an escalation (for scope, cost or security), which pauses the WorkOrder for the user.

## Considered Options

- **A prompt directive telling the working agent to self-answer.** Rejected: the agent asking the question would also be grading its own question.
- **Autopilot variants of each skill.** Rejected: they drift from upstream skills.
- **A fresh Answerer per question.** Rejected: answers could contradict earlier Assumptions.
