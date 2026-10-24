type Principal = { role?: string | null; twoFactorEnabled?: boolean | null };

export function isOwner(user: Principal | null | undefined) {
	return user?.role === "admin";
}
export function canAdminister(user: Principal | null | undefined) {
	return isOwner(user) && user?.twoFactorEnabled === true;
}
export function allowUserCreation(path: string | undefined) {
	return path === "/admin/create-user";
}
