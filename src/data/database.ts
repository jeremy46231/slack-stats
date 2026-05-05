import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../prisma/generated/client.ts'
import { jsDateToPlainDate, plainDateToString } from '../helpers.ts'
import { Temporal } from 'temporal-polyfill'

const adapter = new PrismaPg({
  connectionString: process.env['DATABASE_URL']!,
})
const prismaDB = new PrismaClient({ adapter })

await prismaDB.$connect()

export const db = prismaDB

export async function mostRecentStatDate() {
  const mostRecent = await db.day.findFirst({
    orderBy: { date: 'desc' },
    select: { date: true },
  })
  if (!mostRecent) {
    throw new Error('No stats in the database')
  }
  return jsDateToPlainDate(mostRecent.date)
}

export async function mostRecentFullyLoadedDate() {
  const mostRecent = await db.day.findFirst({
    where: { user_day_loaded: true },
    orderBy: { date: 'desc' },
    select: { date: true },
  })
  if (!mostRecent) {
    throw new Error('No fully loaded stats in the database')
  }
  return jsDateToPlainDate(mostRecent.date)
}

export async function prevFullyLoadedDate(
  before: Temporal.PlainDate
): Promise<Temporal.PlainDate | null> {
  const prev = await db.day.findFirst({
    where: {
      user_day_loaded: true,
      date: { lt: plainDateToString(before) },
    },
    orderBy: { date: 'desc' },
    select: { date: true },
  })
  return prev ? jsDateToPlainDate(prev.date) : null
}

export async function recentFullyLoadedDates(
  count: number
): Promise<Temporal.PlainDate[]> {
  const days = await db.day.findMany({
    where: { user_day_loaded: true },
    orderBy: { date: 'desc' },
    select: { date: true },
    take: count,
  })
  return days.map((d) => jsDateToPlainDate(d.date)).reverse()
}

const oldestStatRecord = await db.day.findFirst({
  orderBy: { date: 'asc' },
  select: { date: true },
})

if (!oldestStatRecord) {
  throw new Error('No stats in the database')
}

export const oldestStatDate = jsDateToPlainDate(oldestStatRecord.date)
