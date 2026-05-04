import { Temporal } from 'temporal-polyfill'
import { getAvailableDates, getRangeStats } from '../slackAPI/userAPI.ts'
import { db } from './database.ts'
import { getCachedUser, refreshCachedUser } from './users.ts'
import {
  daysGenerator,
  jsDateToPlainDate,
  plainDateToString,
  runThreaded,
} from '../helpers.ts'

export type userDay = {
  user_id: string
  date: Temporal.PlainDate
  is_active: boolean
  is_desktop: boolean
  is_ios: boolean
  is_android: boolean
  messages_posted: number
  messages_posted_in_channel: number
  reactions_added: number
}

export async function getDayStats(day: Temporal.PlainDate): Promise<userDay[]> {
  const data = await getRangeStats(day, day)
  const converted = data.map((member) => ({
    user_id: member.user_id,
    date: day,
    is_active: member.days_active > 0,
    is_desktop: member.days_active_desktop > 0,
    is_ios: member.days_active_ios > 0,
    is_android: member.days_active_android > 0,
    messages_posted: member.messages_posted,
    messages_posted_in_channel: member.messages_posted_in_channel,
    reactions_added: member.reactions_added,
  }))
  return converted
}

export async function ensureUsersInDatabase(userIDs: string[]) {
  // Find the user IDs that are missing from the database
  const createMissingResult = await db.user.createManyAndReturn({
    data: userIDs.map((user_id) => ({ user_id })),
    skipDuplicates: true,
    // select: { user_id: true },
  })
  const missingIDs = createMissingResult.map((user) => user.user_id)

  // Get user profiles for missing IDs and add them to the database
  let i = 0
  for (const missingID of missingIDs) {
    await getCachedUser(missingID)
    console.log(`    Fetched new user ${++i}/${missingIDs.length}`)
  }

  return missingIDs
}

export async function getStats(
  startDate: Temporal.PlainDate,
  endDate: Temporal.PlainDate,
  threadCount = 5
) {
  console.log(
    `Fetching stats from ${startDate.toString()} to ${endDate.toString()}`
  )

  // Make sure that records exist for all days in the range
  await db.day.createMany({
    data: [...daysGenerator(startDate, endDate)].map((date) => ({
      date: plainDateToString(date),
    })),
    skipDuplicates: true,
  })
  // Get all days that have not been loaded yet
  const missingDaysResult = await db.day.findMany({
    where: {
      date: {
        gte: plainDateToString(startDate),
        lte: plainDateToString(endDate),
      },
      user_day_loaded: false,
    },
    select: { date: true },
  })
  const missingDays = missingDaysResult.map((day) =>
    jsDateToPlainDate(day.date)
  )

  console.log(`Fetching stats for ${missingDays.length} days`)

  let newStats = 0
  let newUsers = 0

  if (missingDays.length === 0) {
    console.log('No missing days to load stats for')
    return
  }

  // Start threads to fetch the missing days
  await runThreaded(
    missingDays,
    missingDays.length,
    threadCount,
    async (day) => {
      // Get the stats for the day
      const dayStats = await getDayStats(day)
      newStats += dayStats.length

      // If the API returned no data, skip marking as loaded so we retry next run.
      // This handles the case where Slack's analytics data isn't ready yet for a recent day.
      if (dayStats.length === 0) {
        console.log(`  No data returned for ${day.toString()}, will retry next run`)
        return
      }

      // Ensure that all users are in the database
      const userIDs = [...new Set(dayStats.map((day) => day.user_id)).values()]
      const addedIDs = await ensureUsersInDatabase(userIDs)
      newUsers += addedIDs.length

      // Add the stats to the database
      await db.day.update({
        where: {
          date: plainDateToString(day),
        },
        data: {
          user_day_loaded: true,
          UserDay: {
            createMany: {
              data: dayStats.map((stat) => ({
                user_id: stat.user_id,
                is_active: stat.is_active,
                is_desktop: stat.is_desktop,
                is_ios: stat.is_ios,
                is_android: stat.is_android,
                messages_posted: stat.messages_posted,
                messages_posted_in_channel: stat.messages_posted_in_channel,
                reactions_added: stat.reactions_added,
              })),
            },
          },
        },
      })
    }
  )

  console.log(
    `Added ${newStats} new records over ${missingDays.length} days and fetched ${newUsers} new users`
  )
}

export async function updateStats() {
  const availableDates = await getAvailableDates()
  await getStats(availableDates.start_date, availableDates.end_date)
}

export async function refreshProfile(id?: string) {
  if (!id) return
  await refreshCachedUser(id)
}

export async function refreshOldUserProfiles(
  timeAgo = Temporal.Duration.from({ days: 7 }),
  limit?: number
) {
  const oldUsers = await db.user.findMany({
    where: {
      last_updated: {
        lt: new Date(
          Temporal.Now.zonedDateTimeISO('UTC').subtract(timeAgo).toInstant()
            .epochMilliseconds
        ),
      },
    },
    select: { user_id: true },
    orderBy: { last_updated: 'asc' },
    take: limit,
  })

  if (oldUsers.length === 0) {
    console.log('No old user profiles to refresh')
    return
  }

  console.log(`Refreshing ${oldUsers.length} old user profiles...`)

  let i = 0
  for (const user of oldUsers) {
    try {
      await refreshCachedUser(user.user_id)
      console.log(`    Refreshed user ${++i}/${oldUsers.length}`)
    } catch (error) {
      console.error(
        `    Failed to refresh user ${user.user_id} (${i + 1}/${oldUsers.length})`,
        error
      )
      i++
    }
  }

  console.log(`Completed refreshing ${oldUsers.length} user profiles`)
}
