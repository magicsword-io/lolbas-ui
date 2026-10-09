// UI links support the independent site’s configured base path; exported API URLs stay canonical.
export const sitePath = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;
