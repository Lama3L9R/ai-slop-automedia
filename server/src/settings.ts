import { SettingsSchema, type Library, type Settings } from '@automedia/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from './db'

let cache: Settings | undefined

export function getSettings(): Settings {
  if (cache) return cache
  const row = db().select().from(schema.settings).where(eq(schema.settings.key, 'main')).get()
  cache = SettingsSchema.parse(row?.value ?? {})
  return cache
}

export function saveSettings(input: unknown): Settings {
  const value = SettingsSchema.parse(input)
  db()
    .insert(schema.settings)
    .values({ key: 'main', value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
  cache = value
  return value
}

export function resetSettingsCache() {
  cache = undefined
}

export function findLibrary(id: string): Library | undefined {
  return getSettings().libraries.find((l) => l.id === id)
}
