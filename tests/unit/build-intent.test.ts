import { describe, expect, it } from 'vitest'

import type { BuildIntentContext } from '../../src/shared/utils/build-intent'
import {
  decideBuildIntent,
  isBuildFeedback,
  isPlanApproval
} from '../../src/shared/utils/build-intent'

function decide(
  text: string,
  context: Partial<BuildIntentContext> = {}
): ReturnType<typeof decideBuildIntent> {
  return decideBuildIntent(text, { mode: 'auto', ...context })
}

describe('decideBuildIntent', () => {
  it('rejects empty commands, slash commands and bang commands', () => {
    expect(decide('').useBuild).toBe(false)
    expect(decide('   ').useBuild).toBe(false)
    expect(decide('/buildmode status').useBuild).toBe(false)
    expect(decide('!echo hello with a full stack application system').useBuild).toBe(false)
  })

  it('does nothing when Build mode is off', () => {
    const result = decide(
      'Build a complete full-stack inventory management platform with login',
      { mode: 'off' }
    )
    expect(result).toMatchObject({ useBuild: false, reason: 'Build mode is off' })
  })

  it('keeps questions and short requests in normal mode', () => {
    expect(
      decide('How do I build a full-stack application with authentication?').useBuild
    ).toBe(false)
    expect(decide('Build an app').useBuild).toBe(false)
  })

  it('routes large creation requests to Build mode in auto mode', () => {
    const result = decide(
      'Build a full-stack inventory management system with login, dashboard and reports'
    )
    expect(result).toMatchObject({ useBuild: true, continuation: false })
  })

  it('rejects targeted edits and small single-file work', () => {
    expect(decide('Fix the login bug in the settings page please').useBuild).toBe(false)
    expect(decide('Update the dashboard billing widget to show totals').useBuild).toBe(false)
    expect(decide('Implement a function that sorts numbers without libraries').useBuild).toBe(false)
    expect(decide('Add a small helper for parsing dates in this file').useBuild).toBe(false)
  })

  it('does not start a second build while one is active', () => {
    const result = decide(
      'Create a complete REST API with authentication and a database',
      { hasActiveBuild: true }
    )
    expect(result).toMatchObject({ useBuild: false, reason: 'build already running' })
  })

  it('treats continue prompts as resume only when a paused build exists', () => {
    expect(decide('continue', { hasPausedBuild: true })).toMatchObject({
      useBuild: true,
      continuation: true
    })
    expect(decide('Keep going', { hasPausedBuild: true }).useBuild).toBe(true)
    expect(decide('continue', { hasPausedBuild: false }).useBuild).toBe(false)
    expect(decide('continue', { hasPausedBuild: true, mode: 'off' }).useBuild).toBe(false)
  })

  it('honors forced On mode for creation and non-simple work', () => {
    expect(decide('Build a small utility script for my desktop', { mode: 'on' }).useBuild).toBe(true)
    expect(decide('Improve the inventory dashboard layout', { mode: 'on' }).useBuild).toBe(true)
    expect(
      decide('Please prepare the following work items:\n- one\n- two', { mode: 'on' }).useBuild
    ).toBe(true)
  })

  it('still rejects pure edits and unclear requests in forced On mode', () => {
    expect(decide('Fix the login bug in the settings page', { mode: 'on' }).useBuild).toBe(false)
    expect(decide('The banner is slightly too large', { mode: 'on' }).useBuild).toBe(false)
  })

  it('uses complexity as an On-mode signal', () => {
    expect(
      decide('Please prepare the release checklist for this project', {
        mode: 'on',
        complexity: 'complex'
      }).useBuild
    ).toBe(true)
  })

  it('requires a creation verb in auto mode', () => {
    expect(decide('The inventory system needs a database and a dashboard').useBuild).toBe(false)
    expect(
      decide('Here is a list of features for a new CRM:\n- contacts\n- deals', {
        complexity: 'complex'
      }).useBuild
    ).toBe(false)
  })
})

describe('isBuildFeedback', () => {
  it('recognizes plan and requirement changes', () => {
    for (const text of [
      'Change the database to Postgres',
      'Use SQLite instead',
      'Add password reset',
      'Remove the payments milestone',
      'Revise the plan for mobile screens',
      'instead use a sidebar',
      'Keep the dashboard but drop charts',
      'Looks good',
      'approve',
      'yes, approve',
      'start building',
      'start coding'
    ]) {
      expect(isBuildFeedback(text), text).toBe(true)
    }
  })

  it('does not treat unrelated prompts as feedback', () => {
    expect(isBuildFeedback('')).toBe(false)
    expect(isBuildFeedback('What does the build do?')).toBe(false)
    expect(isBuildFeedback('Write a poem about testing')).toBe(false)
  })
})

describe('isPlanApproval', () => {
  it('accepts common approval phrases with trailing punctuation', () => {
    for (const text of ['approve', 'Approved.', 'yes', 'looks good', 'start building', 'go', 'proceed', 'okay!']) {
      expect(isPlanApproval(text), text).toBe(true)
    }
  })

  it('rejects questions and change requests', () => {
    expect(isPlanApproval('approve this plan now please')).toBe(false)
    expect(isPlanApproval('No, change the database')).toBe(false)
    expect(isPlanApproval('wait')).toBe(false)
  })
})
