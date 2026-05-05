import { Temporal } from 'temporal-polyfill'
import { db } from './database.ts'
import {
  streakLeaderboard,
  streakLeaderboardAsOf,
} from '../../prisma/generated/sql.ts'

export const MILESTONES = [50, 100, 200, 365, 730, 1095] as const

export type LeaderboardEntry = {
  user_id: string
  display_name: string | null
  real_name: string | null
  streak_length: number
  rank: number
}

export type LeaderboardDiff = {
  dropped: Array<{ entry: LeaderboardEntry }>
  milestones: Array<{ entry: LeaderboardEntry; milestone: number }>
}

type RawRow = {
  user_id: string
  display_name: string | null
  real_name: string | null
  streak_length: number | null
}

function toRankedEntries(rows: RawRow[]): LeaderboardEntry[] {
  const result: LeaderboardEntry[] = []
  let prevStreak: number | null = null
  let currentRank = 1
  for (let i = 0; i < rows.length; i++) {
    const streakLen = rows[i]!.streak_length ?? 0
    // Standard competition ranking: rank = 1-based position of the first entry
    // with this streak value. Ties share the same rank; the next distinct
    // streak skips to its actual position (e.g. two at 16 → next is 18).
    if (streakLen !== prevStreak) currentRank = i + 1
    result.push({
      user_id: rows[i]!.user_id,
      display_name: rows[i]!.display_name,
      real_name: rows[i]!.real_name,
      streak_length: streakLen,
      rank: currentRank,
    })
    prevStreak = streakLen
  }
  return result
}

export function computeLeaderboardDiff(
  prev: LeaderboardEntry[],
  curr: LeaderboardEntry[]
): LeaderboardDiff {
  const currUserIds = new Set(curr.map((e) => e.user_id))
  const milestoneSet = new Set<number>(MILESTONES)

  const dropped = prev
    .slice(0, 100)
    .filter((e) => !currUserIds.has(e.user_id))
    .map((e) => ({ entry: e }))

  const milestones = curr
    .filter((e) => milestoneSet.has(e.streak_length))
    .map((e) => ({ entry: e, milestone: e.streak_length }))

  return { dropped, milestones }
}

let entries: LeaderboardEntry[] = []

export async function loadLeaderboard(): Promise<LeaderboardDiff> {
  const previousEntries = [...entries]
  const rows = await db.$queryRawTyped(streakLeaderboard())
  entries = toRankedEntries(rows)
  return computeLeaderboardDiff(previousEntries, entries)
}

export async function getLeaderboardAsOf(
  date: Temporal.PlainDate
): Promise<LeaderboardEntry[]> {
  const rows = await db.$queryRawTyped(
    streakLeaderboardAsOf(new Date(date.toString()))
  )
  return toRankedEntries(rows)
}

export function getUserStreakRank(userId: string): LeaderboardEntry | null {
  return entries.find((e) => e.user_id === userId) ?? null
}

export function getLeaderboard(): readonly LeaderboardEntry[] {
  return entries
}
