import { C } from './colors'

export const HELP = `
${C.BOLD}Gemibot.py // GemiBot AI Commands${C.RESET}
  ${C.CYAN}/model${C.RESET}            open interactive model selector (1, 2, 3...)
  ${C.CYAN}/function${C.RESET}         open interactive Function & Mode Selector (Build, Read, Plan, Image UHD, DOCX, Excel, Voice...)
  ${C.CYAN}/build${C.RESET}            switch to BUILD mode (full read, write, multimodal & shell access)
  ${C.CYAN}/buildmode${C.RESET}        whole-system Build pipeline (on, off, auto, status, docs, pause/resume/stop)
  ${C.CYAN}/plan${C.RESET}             switch to PLAN mode (read-only architectural analysis, no edits/commands)
  ${C.CYAN}/read${C.RESET}             switch to READ mode (strict read & media inspection mode)
  ${C.CYAN}/todos${C.RESET}            display active task checklist
  ${C.CYAN}/undo${C.RESET}             revert the last single file change made by the agent
  ${C.CYAN}/revert${C.RESET}           pick a previous prompt checkpoint and roll back code, history and memory
  ${C.CYAN}/target <path>${C.RESET}   set or inspect target project directory (use /target clear to reset)
  ${C.CYAN}/settings${C.RESET}         view saved user preferences from the conversation database
  ${C.CYAN}/memory${C.RESET}           show memory logs and interaction history from the conversation database
  ${C.CYAN}/pip${C.RESET}              check or auto-install all required Python multimedia libraries in .venv
  ${C.CYAN}/clear${C.RESET}            clear active chat context and reset memory
  ${C.CYAN}/usage${C.RESET}            show session token consumption metrics
  ${C.CYAN}/compact${C.RESET}          summarize older messages now to free context space
  ${C.CYAN}/compaction${C.RESET}       view or change auto-compaction settings (on, threshold, recent, model)
  ${C.CYAN}/token${C.RESET}            view token usage totals and efficiency limits
  ${C.CYAN}/style${C.RESET}            set response depth: concise, balanced (default) or thorough
  ${C.CYAN}/deep${C.RESET}             plan, route and verify complex requests (on/off, default on)
  ${C.CYAN}/steps${C.RESET}            set the maximum agent steps per task (10-200, default 40)
  ${C.CYAN}/stream${C.RESET}           stream replies into the timeline as they are written (on/off)
  ${C.CYAN}/help${C.RESET}             show this help menu
  ${C.CYAN}/exit${C.RESET}             shutdown and exit Gemibot CLI

${C.BOLD}Command Chaining (+)${C.RESET}
  You can combine 2 or more commands using '+' with spaces or without spaces:
  - ${C.YELLOW}/plan + /build${C.RESET}
  - ${C.YELLOW}/plan+/build${C.RESET}
  - ${C.YELLOW}/clear + /todos + /usage + /build${C.RESET}
  - ${C.YELLOW}/1 + /3 + /6${C.RESET} (Numeric chaining works too!)

${C.BOLD}Keybinds & Shortcuts${C.RESET}
  ${C.YELLOW}Esc${C.RESET}               interrupt AI generation, reply output, or running command
  ${C.CYAN}@path${C.RESET}             attach a file inline, e.g. fix the bug in @src/app.py
  ${C.CYAN}!command${C.RESET}          execute a shell command directly in project root (e.g. !git status)
  ${C.CYAN}\\ (line end)${C.RESET}      continue your prompt on the next line
`
