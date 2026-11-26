# Sofra recipe image convention

Each recipe uses a local WebP file at `/images/recipes/<recipe-slug>.webp`.

When adding a recipe:
1. Generate a unique food photo in the same visual style: natural warm light, ivory ceramic plate, neutral tabletop, realistic food photography.
2. Save it under `public/images/recipes/` using the recipe-name slug (Turkish characters transliterated to ASCII), for example `yeni-yemek.webp`.
3. Add the recipe to the recipe catalog using the same name. The UI resolves the matching image path automatically.
4. Never reuse another recipe's image; if a matching file is missing, the UI shows the recipe emoji fallback rather than a mismatched photo.
