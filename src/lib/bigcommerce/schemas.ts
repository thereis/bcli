import { z } from 'zod';

export const formFieldValueSchema = z.object({
  name: z.string(),
  value: z.string().nullable(),
  customer_id: z.number(),
});

export const addressSchema = z
  .object({
    country: z.string(),
  })
  .loose();

export const formFieldSchema = z.object({
  name: z.string(),
  value: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
});

export const customerSchema = z
  .object({
    id: z.number(),
    email: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone: z.string(),
    addresses: z.array(addressSchema),
    form_fields: z.array(formFieldSchema),
  })
  .loose();

export const storeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  plan_name: z.string(),
  plan_level: z.string(),
  status: z.string(),
});

export const paginationSchema = z.object({
  total: z.number(),
  count: z.number(),
  per_page: z.number(),
  current_page: z.number(),
  total_pages: z.number(),
});

export const cursorPaginationSchema = z.object({
  count: z.number(),
  per_page: z.number(),
  end_cursor: z.string(),
  links: z.object({
    next: z.string().optional(),
  }),
});

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(
  dataSchema: T,
) =>
  z.object({
    data: z.array(dataSchema),
    meta: z.object({
      pagination: paginationSchema.optional(),
      cursor_pagination: cursorPaginationSchema.optional(),
    }),
  });

export const progressStateSchema = z.object({
  cursor: z.string().optional(),
  pageNum: z.number(),
  collectedIds: z.array(z.number()),
  processedIdIndex: z.number(),
});

export type FormFieldValue = z.infer<typeof formFieldValueSchema>;
export type Address = z.infer<typeof addressSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type StoreInfo = z.infer<typeof storeInfoSchema>;
export type PaginatedResponse<T> = {
  data: T[];
  meta: {
    pagination?: z.infer<typeof paginationSchema>;
    cursor_pagination?: z.infer<typeof cursorPaginationSchema>;
  };
};
export type ProgressState = z.infer<typeof progressStateSchema>;
