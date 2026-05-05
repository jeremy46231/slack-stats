import { Temporal } from 'temporal-polyfill'
import type {
  HeaderBlock,
  KnownBlock,
  RichTextBlock,
  RichTextBlockElement,
  RichTextElement,
  RichTextList,
  RichTextSection,
  RichTextText,
  RichTextUserMention,
  TableBlock,
} from '@slack/types'
import { app } from './slackAPI/app.ts'
import {
  db,
  prevFullyLoadedDate,
  recentFullyLoadedDates,
} from './data/database.ts'
import {
  loadLeaderboard,
  getLeaderboard,
  getLeaderboardAsOf,
  computeLeaderboardDiff,
  type LeaderboardEntry,
  type LeaderboardDiff,
} from './data/streakLeaderboard.ts'

export const REPORT_CHANNEL_ID = 'C09RY3A75JR'

// DMs require the Messages Tab enabled in Slack App settings + im:write scope.
const TEST_CHANNEL = 'U06UYA5GMB5'

// ─── Block Kit helpers ────────────────────────────────────────────────────────

function plainText(text: string): RichTextText {
  return { type: 'text', text }
}

function boldText(text: string): RichTextText {
  return { type: 'text', text, style: { bold: true } }
}

function userMention(user_id: string): RichTextUserMention {
  return { type: 'user', user_id }
}

function richTextCell(elements: RichTextElement[]): RichTextBlock {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements } as RichTextSection],
  }
}

function richTextSection(elements: RichTextElement[]): RichTextSection {
  return { type: 'rich_text_section', elements }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatDate(date: Temporal.PlainDate): string {
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  switch (v % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

function milestoneLabel(days: number): string {
  if (days === 365) return '1 year'
  if (days === 730) return '2 year'
  if (days === 1095) return '3 year'
  return `${days} day`
}

// ─── Block builder ────────────────────────────────────────────────────────────

function buildLeaderboardBlocks(
  date: Temporal.PlainDate,
  entries: LeaderboardEntry[],
  diff: LeaderboardDiff
): KnownBlock[] {
  // Table block max is 100 rows total; 1 is the header, so 99 data rows max.
  const top100 = entries.slice(0, 99)

  const headerRow: RichTextBlock[] = [
    richTextCell([boldText('#')]),
    richTextCell([boldText('Person')]),
    richTextCell([boldText('Streak')]),
  ]

  const dataRows: RichTextBlock[][] = top100.map((e) => [
    richTextCell([plainText(String(e.rank))]),
    richTextCell([userMention(e.user_id)]),
    richTextCell([plainText(`${e.streak_length} days`)]),
  ])

  const header: HeaderBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${formatDate(date)} Leaderboard`,
      emoji: true,
    },
  }

  const table: TableBlock = {
    type: 'table',
    rows: [headerRow, ...dataRows],
  }

  const blocks: KnownBlock[] = [header, table]

  const listItems: RichTextSection[] = [
    ...diff.dropped.map((d) =>
      richTextSection([
        userMention(d.entry.user_id),
        plainText(
          ` broke their ${d.entry.streak_length} day streak! They were ${ordinal(d.entry.rank)}.`
        ),
      ])
    ),
    ...diff.milestones.map((m) =>
      richTextSection([
        userMention(m.entry.user_id),
        plainText(` just reached a ${milestoneLabel(m.milestone)} streak!`),
      ])
    ),
  ]

  if (listItems.length > 0) {
    const list: RichTextList = {
      type: 'rich_text_list',
      style: 'bullet',
      indent: 0,
      border: 0,
      elements: listItems,
    }
    const richText: RichTextBlock = {
      type: 'rich_text',
      elements: [list as RichTextBlockElement],
    }
    blocks.push(richText)
  }

  return blocks
}

// ─── Public send functions ────────────────────────────────────────────────────

export async function sendLeaderboardMessage(
  channel: string,
  date: Temporal.PlainDate,
  entries: LeaderboardEntry[],
  diff: LeaderboardDiff
): Promise<void> {
  const blocks = buildLeaderboardBlocks(date, entries, diff)
  await app.client.chat.postMessage({
    channel,
    blocks,
    text: `${formatDate(date)} Leaderboard`,
  })
}

/** Called by main.ts when new stat data is detected. Refreshes in-memory
 *  leaderboard and posts the update to the report channel. */
export async function sendLeaderboardUpdate(
  channel: string,
  date: Temporal.PlainDate
): Promise<void> {
  const diff = await loadLeaderboard()
  const entries = getLeaderboard()
  await sendLeaderboardMessage(
    channel,
    date,
    entries as LeaderboardEntry[],
    diff
  )
}

/** Generate and send a leaderboard message for an arbitrary historical date. */
export async function sendLeaderboardForDate(
  channel: string,
  date: Temporal.PlainDate
): Promise<void> {
  const currEntries = await getLeaderboardAsOf(date)
  const prevDate = await prevFullyLoadedDate(date)
  const prevEntries = prevDate ? await getLeaderboardAsOf(prevDate) : []
  const diff = computeLeaderboardDiff(prevEntries, currEntries)
  await sendLeaderboardMessage(channel, date, currEntries, diff)
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2)

  try {
    if (args[0] === '--week') {
      // Fetch 8 dates so we have a "prev" baseline for the oldest of the 7 messages
      const dates = await recentFullyLoadedDates(8)
      if (dates.length < 2) {
        throw new Error('Not enough loaded dates for a week of messages')
      }
      // dates is in ASC order; send a message for each date except the oldest
      for (let i = 1; i < dates.length; i++) {
        const date = dates[i]!
        const prevDate = dates[i - 1]!
        const currEntries = await getLeaderboardAsOf(date)
        const prevEntries = await getLeaderboardAsOf(prevDate)
        const diff = computeLeaderboardDiff(prevEntries, currEntries)
        await sendLeaderboardMessage(TEST_CHANNEL, date, currEntries, diff)
        console.log(`Sent message for ${date}`)
      }
    } else if (args[0]) {
      const date = Temporal.PlainDate.from(args[0])
      await sendLeaderboardForDate(TEST_CHANNEL, date)
      console.log(`Sent message for ${date}`)
    } else {
      console.error('Usage: bun src/leaderboardMessage.ts YYYY-MM-DD | --week')
      process.exit(1)
    }
  } finally {
    await db.$disconnect()
  }
}
