# Haftalık Menü Planlayıcı

Türk mutfağı tarifleriyle haftalık menü oluşturma ve reyonlara göre alışveriş listesi hazırlama uygulaması.

## Çalıştırma
```bash
npm install
npm start
```

## Ortam değişkenleri
- `PORT`: Railway tarafından sağlanır.
- `DATABASE_URL`: PostgreSQL bağlantı adresi.
- `DATABASE_SSL`: Gerekirse `false` ile SSL kapatılabilir.

Veritabanı tabloları için `schema.sql` dosyasını PostgreSQL üzerinde çalıştırın.

## Sağlık kontrolü
`/api/health`

## Teknoloji
- Node.js + Express
- PostgreSQL
- Railway deployment