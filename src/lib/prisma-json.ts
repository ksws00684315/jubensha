import type { Prisma } from "@prisma/client";

/** Convert an already validated record to Prisma's JSON input shape. */
export function toPrismaJsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value));
}
