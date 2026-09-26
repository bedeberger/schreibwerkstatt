// Buch-Guard nach `await`: Loader lesen die Buch-ID vor dem Fetch und schreiben
// das Ergebnis danach in die Karte. Wechselt der User in der Zwischenzeit das
// Buch, landet sonst die Antwort des alten Buchs in der Karte des neuen (und
// überschreibt dort den gerade frisch geladenen Stand).
//
//   const bookId = Alpine.store('nav').selectedBookId;
//   const data = await fetchJson(`/x/${bookId}`);
//   if (!isSelectedBook(bookId)) return;
//   this.xData = data;

/** true, wenn `bookId` (noch) das aktuell gewählte Buch ist. */
export function isSelectedBook(bookId) {
  const current = window.Alpine?.store('nav')?.selectedBookId;
  return bookId != null && bookId !== '' && String(bookId) === String(current ?? '');
}
