// Tarif kataloğu tamamen backend API'den yüklenir.
(async function loadRecipesFromApi() {
  const grid = document.getElementById("recipeGrid");
  if (grid) grid.innerHTML = '<div class="empty-state">Tarifler yükleniyor…</div>';
  try {
    const response = await fetch("/api/recipes", { cache: "no-store" });
    if (!response.ok) throw new Error("Tarif API yanıtı: " + response.status);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Tarif API beklenmeyen veri döndürdü.");
    recipes.splice(0, recipes.length, ...data.map(r => ({
      ...r, id: Number(r.id),
      ingredients: (r.ingredients || []).map(x => Array.isArray(x) ? x : [x.name, x.quantity, x.aisle]),
      instructions: r.instructions || [], tags: r.tags || [], imageQuery: r.imageQuery || ""
    })));
    stewMainIds.splice(0, stewMainIds.length, ...recipes.filter(r => r.category === "Ana yemek").map(r => r.id));
    fitMainIds.splice(0, fitMainIds.length, ...recipes.filter(r => r.category === "Ana yemek").map(r => r.id));
    const filter = document.getElementById("categoryFilter");
    if (filter) {
      const categories = [...new Set(recipes.map(r => r.category))];
      filter.innerHTML = '<option value="all">Tüm kategoriler</option>' + categories.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join("");
      filter.value = "all";
    }
    renderCatalog(); renderFavorites(); renderHomeDashboard();
    if (typeof loadRecipeImages === "function") loadRecipeImages();
    console.info("Tarif API:", recipes.length, "tarif yüklendi.");
  } catch (error) {
    console.error("Tarif API yüklenemedi:", error);
    if (grid) grid.innerHTML = '<div class="empty-state">Tarifler şu anda yüklenemiyor. Lütfen sayfayı yenileyin.</div>';
  }
})();
