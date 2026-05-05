import { app } from './slackAPI/app.ts'
import { updateStats, refreshOldUserProfiles } from './data/getStats.ts'
import { Temporal } from 'temporal-polyfill'
import {
  convertSlackProfileToDbUser,
  type SlackProfile,
} from './slackAPI/botAPI.ts'
import { db, mostRecentFullyLoadedDate } from './data/database.ts'
import { loadLeaderboard } from './data/streakLeaderboard.ts'
import {
  sendLeaderboardUpdate,
  REPORT_CHANNEL_ID,
} from './leaderboardMessage.ts'
import './messageHandler.ts'

app.event('user_profile_changed', async ({ event }) => {
  const userId = event.user.id
  const rawProfile = event.user.profile as SlackProfile
  if (!rawProfile) {
    console.error('No profile data in user_profile_changed event')
    return
  }
  const profile = convertSlackProfileToDbUser(rawProfile, userId)
  await db.user.upsert({
    where: { user_id: profile.user_id },
    create: profile,
    update: profile,
  })
})

const TASKS_DELAY_MS = 10 * 60 * 1000

let lastKnownStatDate: Temporal.PlainDate | null = null

async function newData(newDate: Temporal.PlainDate) {
  console.log(
    `New stat data detected for ${newDate}, refreshing leaderboard...`
  )
  try {
    await sendLeaderboardUpdate(REPORT_CHANNEL_ID, newDate)
    console.log('Leaderboard refreshed and message sent')
  } catch (error) {
    console.error('Error in newData routine:', error)
  }
}

async function tasks() {
  console.log('Running tasks...')

  try {
    await updateStats()
  } catch (error) {
    console.error('Error updating stats:', error)
  }

  try {
    await refreshOldUserProfiles(Temporal.Duration.from({ days: 7 }), 200)
  } catch (error) {
    console.error('Error refreshing old user profiles:', error)
  }

  console.log('Tasks completed')

  try {
    const currentDate = await mostRecentFullyLoadedDate()
    // On the first pass lastKnownStatDate is null — just capture the baseline
    // without firing newData. Only trigger on a forward advance (> 0) so
    // backfill/repair writes don't post a stale leaderboard.
    if (
      lastKnownStatDate !== null &&
      Temporal.PlainDate.compare(currentDate, lastKnownStatDate) > 0
    ) {
      await newData(currentDate)
    }
    lastKnownStatDate = currentDate
  } catch (error) {
    console.error('Error checking for new stat data:', error)
  }

  setTimeout(tasks, TASKS_DELAY_MS)
}

// Load leaderboard into memory before starting, so rank lookups in reports
// are available immediately on first user request.
await loadLeaderboard()
await app.start()
tasks()
