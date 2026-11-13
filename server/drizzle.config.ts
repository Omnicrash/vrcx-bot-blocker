// Migrations are generated from src/db/schema.ts with drizzle-kit and applied at boot.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
    dialect: 'sqlite',
    schema: './src/db/schema.ts',
    out: './drizzle'
})
