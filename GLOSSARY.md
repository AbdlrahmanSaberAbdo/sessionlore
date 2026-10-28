# habitlore

habitlore reads past AI coding sessions, finds the work a person keeps repeating, and turns it into Suggestions that teach their agents.

## Sources

**Harness**:
A coding tool whose sessions habitlore reads, such as Claude Code or Cursor.
_Avoid_: Provider, source, tool, agent

**Model Provider**:
The LLM service habitlore itself calls during Analysis, chosen by the user.
_Avoid_: Provider (alone), LLM, backend

**Session**:
One conversation in a Harness, from its first message to its last. Subagent runs started inside it belong to it.
_Avoid_: Conversation, chat, composer, thread, transcript

**User Message**:
A message the person typed in a Session. Text written by the agent, subagents or the Harness never counts.
_Avoid_: Prompt, turn

**Adapter**:
The part that reads one Harness's storage during a Scan.
_Avoid_: Parser, importer, connector

**Project**:
The git repository a Session worked in, including all its worktrees and subfolders. A folder outside git is its own Project.
_Avoid_: Workspace, repo, directory, cwd

## Analysis

**Scan**:
Reading Harness storage into habitlore's local store. Uses no Model Provider.
_Avoid_: Import, sync, ingest

**Analysis**:
The steps that use the Model Provider: splitting Sessions into Tasks, labelling Intents, naming Clusters and writing Suggestions.
_Avoid_: Processing, mining

**Task**:
One goal the person pursued inside a single Session. A goal continued in another Session is a separate Task.
_Avoid_: Job, request, issue

**Intent**:
The purpose of a User Message: New Task, Correction, Clarification, Approval or Follow-up.
_Avoid_: Label, category, type

**Correction**:
A User Message that rejects or fixes something the agent did. Asking for more, or changing one's own mind, is a Follow-up instead.
_Avoid_: Fix, redirect, pushback

**Cluster**:
A group of similar Tasks.
_Avoid_: Pattern, group, habit

**Correction Cluster**:
A group of similar Corrections, gathered across all Tasks regardless of Workflow.
_Avoid_: Repeated feedback, pet peeve

**Repeat Rule**:
The threshold a Cluster or Correction Cluster must pass before it earns a Suggestion: by default at least 3 members across at least 2 Sessions within 60 days.
_Avoid_: Threshold, minimum

**Workflow**:
A Cluster that passes the Repeat Rule. A Workflow lasts across Analyses: new Tasks join it, and it is only reshaped when the person explicitly asks for a full re-cluster.
_Avoid_: Pattern, routine, habit

## Suggestions

**Suggestion**:
A proposed change to how the person's agents behave, derived from a Workflow or a Correction Cluster.
_Avoid_: Draft, recommendation, proposal

**Skill**:
The kind of Suggestion that is a reusable procedure an agent can follow. Skills come from Workflows.
_Avoid_: Playbook, recipe

**Rule**:
The kind of Suggestion that is a one-line standing instruction. Rules come from Correction Clusters.
_Avoid_: Guideline, preference, convention

**Evidence**:
The Tasks or Corrections a Suggestion was derived from, each linked to its Session.
_Avoid_: Sources, references, citations

**Target**:
The existing Skill or Rule a Suggestion updates. Only files the person owns can be a Target; skills that come from plugins never are. A Suggestion without a Target creates something new.
_Avoid_: Base, original, parent

**Pending**, **Accepted**, **Rejected**:
The states of a Suggestion. Accepting installs it, or applies it to its Target; a Rejected Suggestion is remembered so it is not proposed again.
_Avoid_: Installed, approved, dismissed

**Scope**:
Where an Accepted Suggestion is installed: Project scope (one Project) or User scope (all of the person's work).
_Avoid_: Location, level, target

**Renderer**:
The part that turns a Suggestion into one Harness's file format.
_Avoid_: Exporter, formatter, generator

## Measuring

**Corrections per Task**:
The number of Corrections in a Task, averaged over a Workflow. The main sign that agents are improving.
_Avoid_: Error rate, friction
