import { z } from "zod";

const categories = z.array(z.string().max(500)).max(20000).nullable();
export const categoryVisibility = z
	.object({ tv: categories, movie: categories, series: categories })
	.strict();
export type CategoryVisibility = z.infer<typeof categoryVisibility>;
export const allCategories: CategoryVisibility = {
	tv: null,
	movie: null,
	series: null,
};
export function visibleCategories(
	value: unknown,
	kind: string,
): string[] | null {
	const parsed = categoryVisibility.parse(value ?? allCategories);
	const key = kind === "episode" ? "series" : kind;
	return key === "tv" || key === "movie" || key === "series" ? parsed[key] : [];
}
export const updateCategoryVisibility = z
	.object({
		revision: z.number().int().min(0),
		sourceRevision: z.number().int().positive(),
		visibility: categoryVisibility,
	})
	.strict();
