import { Temporal } from 'temporal-polyfill'
import type { ReactNode } from 'react'
import { db, mostRecentStatDate, oldestStatDate } from '../data/database.ts'
import { getCachedUser } from '../data/users.ts'
import { getLeaderboardAsOf } from '../data/streakLeaderboard.ts'
import { jsDateToPlainDate } from '../helpers.ts'
import { makeCalendar } from './calendar.tsx'
import { renderImage } from './image.tsx'
import { makeChart } from './chart.tsx'
import { makeStatsWidget } from './stats.tsx'
import { parseReportRequest, type ReportMode } from './request.ts'

export type dayInfo = {
  date: Temporal.PlainDate
  user_id: string
  is_active: boolean
  is_desktop: boolean
  is_ios: boolean
  is_android: boolean
  messages_posted: number
  messages_posted_in_channel: number
  reactions_added: number
}

export type ReportData = {
  endDate: Temporal.PlainDate
  user: Awaited<ReturnType<typeof getCachedUser>>
  userDays: dayInfo[]
}

function calculateStreak(
  activityByDate: Map<string, dayInfo>,
  endDate: Temporal.PlainDate
) {
  let streakLength = 0
  let currentDate = endDate

  while (true) {
    const dayInfo = activityByDate.get(currentDate.toString())
    if (dayInfo && dayInfo.is_active) {
      streakLength++
      currentDate = currentDate.subtract({ days: 1 })
    } else {
      break
    }
  }

  const streakStartDate = endDate.subtract({ days: streakLength - 1 })
  const streakLongerThanMax =
    Temporal.PlainDate.compare(streakStartDate, oldestStatDate) <= 0

  return {
    streakLength,
    streakStartDate,
    streakLongerThanMax,
  }
}

function getUserLabel(user: {
  display_name: string | null
  real_name: string | null
  user_id: string
}) {
  return user.display_name || user.real_name || user.user_id
}

function getUserInitials(user: {
  display_name: string | null
  real_name: string | null
  user_id: string
}) {
  return (
    getUserLabel(user)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

async function inlineImage(url?: string | null) {
  if (!url) return undefined

  try {
    const response = await fetch(url)
    if (!response.ok) return undefined

    const contentType =
      response.headers.get('content-type') || 'application/octet-stream'
    const bytes = new Uint8Array(await response.arrayBuffer())
    const base64 = Buffer.from(bytes).toString('base64')

    return `data:${contentType};base64,${base64}`
  } catch {
    return undefined
  }
}

function alignedSundayOnOrBefore(date: Temporal.PlainDate) {
  let current = date
  while (current.dayOfWeek !== 7) {
    current = current.subtract({ days: 1 })
  }
  return current
}

function getDefaultVisibleStartDate(endDate: Temporal.PlainDate) {
  return endDate.subtract({ years: 1 }).add({ days: 1 })
}

function getUserActivityStartDate(userDays: dayInfo[]) {
  if (userDays.length === 0) {
    return undefined
  }

  return userDays.reduce(
    (oldest, day) =>
      Temporal.PlainDate.compare(day.date, oldest) < 0 ? day.date : oldest,
    userDays[0]!.date
  )
}

function getVisibleStartDate(
  mode: ReportMode,
  endDate: Temporal.PlainDate,
  userDays: dayInfo[]
) {
  const defaultVisibleStartDate = getDefaultVisibleStartDate(endDate)
  const userActivityStartDate = getUserActivityStartDate(userDays)

  if (mode !== 'all' || !userActivityStartDate) {
    return defaultVisibleStartDate
  }

  return Temporal.PlainDate.compare(
    userActivityStartDate,
    defaultVisibleStartDate
  ) < 0
    ? userActivityStartDate
    : defaultVisibleStartDate
}

function buildStackedYearRanges(
  userDays: dayInfo[],
  endDate: Temporal.PlainDate
) {
  const userActivityStartDate = getUserActivityStartDate(userDays)
  const firstYear = userActivityStartDate?.year ?? endDate.year
  const ranges: Array<{
    startDate: Temporal.PlainDate
    endDate: Temporal.PlainDate
  }> = []

  for (let year = firstYear; year <= endDate.year; year++) {
    const startDate = Temporal.PlainDate.from({ year, month: 1, day: 1 })
    const endOfYear = Temporal.PlainDate.from({ year, month: 12, day: 31 })
    ranges.push({
      startDate,
      endDate:
        year === endDate.year &&
        Temporal.PlainDate.compare(endDate, endOfYear) < 0
          ? endDate
          : endOfYear,
    })
  }

  return ranges
}

function shouldShowMissingDataWarning(userDays: dayInfo[]) {
  const dataCoverageWarningCutoff = oldestStatDate.add({ months: 3 })
  return userDays.some(
    (day) =>
      Temporal.PlainDate.compare(day.date, dataCoverageWarningCutoff) <= 0
  )
}

export async function generateReport(
  userId: string,
  _mode: ReportMode = 'default'
) {
  console.time('data fetching')
  const [user, endDate] = await Promise.all([
    getCachedUser(userId),
    mostRecentStatDate(),
  ])
  const userWithDays = await db.user.findUnique({
    where: { user_id: user.user_id },
    include: { UserDay: true },
  })
  console.timeEnd('data fetching')

  if (!userWithDays) {
    throw new Error(`User with ID ${userId} not found`)
  }

  return {
    user,
    endDate,
    userDays: userWithDays.UserDay.map((day) => ({
      ...day,
      date: jsDateToPlainDate(day.date),
    })),
  }
}

export function generateReportCsv(userDays: dayInfo[]) {
  const headers = [
    'date',
    'is_active',
    'is_desktop',
    'is_ios',
    'is_android',
    'messages_posted',
    'reactions_added',
  ]
  const rows = [...userDays]
    .sort((a, b) => Temporal.PlainDate.compare(a.date, b.date))
    .map((day) =>
      [
        day.date.toString(),
        day.is_active ? 't' : 'f',
        day.is_desktop ? 't' : 'f',
        day.is_ios ? 't' : 'f',
        day.is_android ? 't' : 'f',
        day.messages_posted,
        day.reactions_added,
      ].join(',')
    )

  return `${headers.join(',')}\n${rows.join('\n')}`
}

export async function generateReportImage(
  userId: string,
  mode: ReportMode = 'default'
) {
  const { user, endDate, userDays } = await generateReport(userId, mode)

  console.time('data processing')
  const activityByDate = new Map<string, dayInfo>()
  for (const day of userDays) {
    activityByDate.set(day.date.toString(), day)
  }

  const { streakLength, streakStartDate, streakLongerThanMax } =
    calculateStreak(activityByDate, endDate)
  const [streakRankEntry, avatarSrc] = await Promise.all([
    streakLength > 0
      ? getLeaderboardAsOf(endDate).then(
          (lb) => lb.find((e) => e.user_id === userId) ?? null
        )
      : Promise.resolve(null),
    inlineImage(user.profile_picture),
  ])
  const statsElement = makeStatsWidget(userDays)
  const showMissingDataWarning = shouldShowMissingDataWarning(userDays)

  const isStacked = mode === 'stacked'
  const visibleStartDate = getVisibleStartDate(mode, endDate, userDays)

  let chartElement: ReactNode = null
  let chartHeight = 0
  let calendarElement: ReactNode
  let calendarWidth: number
  let calendarHeight: number

  if (isStacked) {
    const stackedCalendars = await Promise.all(
      buildStackedYearRanges(userDays, endDate).map(({ startDate, endDate }) =>
        makeCalendar(activityByDate, startDate, endDate, true, oldestStatDate)
      )
    )

    calendarWidth = Math.max(
      ...stackedCalendars.map((calendar) => calendar.calendarWidth)
    )
    calendarHeight = stackedCalendars.reduce(
      (sum, calendar, index) =>
        sum + calendar.calendarHeight + (index === 0 ? 0 : 8),
      0
    )
    calendarElement = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {stackedCalendars.map((calendar, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
            }}
          >
            {calendar.calendarElement}
          </div>
        ))}
      </div>
    )
  } else {
    const calendarStartDate = alignedSundayOnOrBefore(visibleStartDate)
    const calendar = await makeCalendar(
      activityByDate,
      calendarStartDate,
      endDate,
      mode === 'all',
      oldestStatDate
    )
    calendarElement = calendar.calendarElement
    calendarWidth = calendar.calendarWidth
    calendarHeight = calendar.calendarHeight

    chartHeight = 150
    chartElement = await makeChart(
      activityByDate,
      calendarStartDate,
      endDate,
      calendarWidth,
      chartHeight
    )
  }

  const element = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'white',
        padding: 10,
        gap: 10,
      }}
    >
      <div
        style={{
          height: 60,
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
          }}
        >
          {avatarSrc ? (
            <img
              src={avatarSrc}
              width={60}
              height={60}
              style={{
                width: 60,
                height: 60,
                borderRadius: '50%',
                objectFit: 'cover',
              }}
            />
          ) : (
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: '50%',
                backgroundColor: '#dbeafe',
                color: '#1d4ed8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'Roboto',
                fontSize: 24,
                fontWeight: 700,
              }}
            >
              {getUserInitials(user)}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              marginLeft: 12,
              fontFamily: 'Roboto',
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 'bold' }}>
              {getUserLabel(user)}
            </span>
            <span style={{ fontSize: 14, color: '#555' }}>
              {streakLength === 0 ? (
                'No current streak'
              ) : (
                <>
                  Current streak: {streakLongerThanMax ? 'at least ' : ''}
                  {streakLength} days (
                  {streakRankEntry ? `#${streakRankEntry.rank}, ` : ''}
                  {streakLongerThanMax ? 'no data before ' : 'since '}
                  {streakStartDate.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                  )
                </>
              )}
            </span>
          </div>
        </div>
        <div
          style={{
            width: 320,
            height: 60,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'flex-start',
          }}
        >
          {statsElement}
        </div>
      </div>
      {chartElement}
      {calendarElement}
      <div
        style={{
          height: 12,
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'flex-end',
          fontSize: 10,
          color: '#333',
          fontFamily: 'Roboto',
        }}
      >
        {showMissingDataWarning && (
          <>
            No data before{' '}
            {oldestStatDate.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}{' '}
            &bull;&nbsp;
          </>
        )}
        Data updated{' '}
        {endDate.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}{' '}
        &bull; Made by
        <span
          style={{
            height: 11,
            marginLeft: 1,
            paddingLeft: 1.5,
            paddingRight: 1,
            backgroundColor: '#1d9bd11a',
            color: '#1264a3',
            borderRadius: 3,
          }}
        >
          @Jeremy
        </span>
        &nbsp;&bull; Get yours in
        <span
          style={{
            height: 11,
            paddingLeft: 1.5,
            paddingRight: 1,
            backgroundColor: '#1d9bd11a',
            color: '#1264a3',
            borderRadius: 3,
          }}
        >
          #slack-stats
        </span>
        !
      </div>
    </div>
  )
  const sectionCount = chartElement === null ? 3 : 4
  const containerPadding = 20
  const containerGap = (sectionCount - 1) * 10
  const width = 10 + calendarWidth + 10
  const height =
    containerPadding + 60 + chartHeight + calendarHeight + 12 + containerGap

  console.timeEnd('data processing')

  return renderImage(element, width, height, {
    mode: 'zoom',
    value: 2,
  })
}

if (import.meta.main) {
  const requestText = Bun.argv.slice(2).join(' ').trim()
  if (!requestText) {
    throw new Error(
      'Usage: bun src/reports/report.tsx <user-id|@mention> [all|"all time"|stacked|csv|"raw data"|data]'
    )
  }
  const { requestedUserId, mode } = parseReportRequest(requestText)
  if (!requestedUserId) {
    throw new Error('CLI input must start with a Slack user ID or mention.')
  }
  try {
    if (mode === 'csv') {
      console.time('csv generation')
      const { userDays } = await generateReport(requestedUserId, mode)
      await Bun.write('./tmp-calendar.csv', generateReportCsv(userDays))
      console.timeEnd('csv generation')
      console.log(
        `Raw data saved to tmp-calendar.csv for user ${requestedUserId}`
      )
    } else {
      console.time('calendar generation')
      const pngData = await generateReportImage(requestedUserId, mode)
      await Bun.write('./tmp-calendar.png', pngData)
      console.timeEnd('calendar generation')
      console.log(
        `Calendar saved to tmp-calendar.png for user ${requestedUserId}${mode === 'default' ? '' : ` (${mode})`}`
      )
    }
  } finally {
    await db.$disconnect()
  }
}
