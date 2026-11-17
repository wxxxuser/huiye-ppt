export function Icon({ name, size = 20 }: {name: string; size?: number}) {
  const paths: Record<string, string> = {
    spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
    slides: 'M4 3h16v14H4V3Zm8 14v4m-4 0h8M8 7h8M8 11h5',
    arrow: 'M4 12h15m-6-6 6 6-6 6',
    back: 'M20 12H5m6-6-6 6 6 6',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
    check: 'm5 12 4 4L19 6',
    file: 'M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h8',
    link: 'M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2',
    edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5',
    plus: 'M12 5v14M5 12h14',
    undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
    redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
    copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    close: 'm6 6 12 12M6 18 18 6',
    up: 'm6 15 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    refresh: 'M20 7a9 9 0 1 0 1 8M20 3v5h-5',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
    info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7h.01',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.file}/></svg>;
}
