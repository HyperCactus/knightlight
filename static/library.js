$("#import-pgn").onclick = () => $("#pgn-files").click();
$("#pgn-files").onchange = async () => {
  const files = [...$("#pgn-files").files];
  if (!files.length) return;
  const button = $("#import-pgn"),
    status = $("#library-status");
  button.disabled = true;
  button.textContent = "Importing…";
  let imported = 0,
    duplicates = 0,
    rejected = 0,
    failed = 0;
  const importedIndices = new Set();
  $("#import-messages").replaceChildren();
  $("#import-details").hidden = true;
  const detail = (text) => {
    const item = document.createElement("li");
    item.textContent = text;
    $("#import-messages").append(item);
    $("#import-details").hidden = false;
  };
  try {
    for (const file of files) {
      try {
        if (file.size > 128 * 1024 * 1024)
          throw Error(file.name + " exceeds 128 MB.");
        status.textContent = "Reading " + file.name + "…";
        const r = await api("imports", { pgn: await file.text() });
        imported += r.imported;
        duplicates += r.duplicates;
        rejected += r.rejected.length;
        r.rejected.forEach((message) => detail(file.name + ": " + message));
        r.indices.forEach(index => importedIndices.add(index));
      } catch (e) {
        failed++;
        detail(file.name + ": " + e.message);
      }
    }
    const d = await (await fetch("/api/data")).json();
    update(d);
    profileAt = 0;
    refreshProfile();
    status.textContent =
      `${imported} imported · ${duplicates} duplicates skipped` +
      (rejected ? ` · ${rejected} invalid games skipped` : "") +
      (failed ? ` · ${failed} files could not be imported` : "");
    const newestImported = reviewLibraryEntries(d.games).find(entry => importedIndices.has(entry.index));
    if (newestImported) {
      gameIndex = newestImported.index;
      replayPly = 0;
      currentReview = null;
      navigate("games");
      replay();
    }
    poll();
  } catch (e) {
    status.textContent = "Import failed: " + e.message;
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = "＋ Import PGN";
    $("#pgn-files").value = "";
  }
};
