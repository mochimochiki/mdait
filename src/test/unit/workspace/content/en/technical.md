<!-- mdait 7e036d8a from:7e036d8a need:translate -->
# 技術ドキュメント

![Build](https://img.shields.io/badge/build-passing-green) ![Coverage](https://img.shields.io/badge/coverage-87%25-yellow)

<!-- mdait bad0569a from:bad0569a need:translate -->
## システムアーキテクチャ

本システムはマイクロサービスアーキテクチャを採用しており、各サービスの独立した開発・デプロイ・スケーリングが可能である。

```
┌─────────────────────────────────────────┐
│          クライアントアプリケーション      │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│            APIゲートウェイ                │
│        (Kong / AWS API Gateway)         │
└─────┬───────────┬───────────┬───────────┘
      │           │           │
┌─────▼─────┐ ┌──▼──────┐ ┌─▼──────────┐
│ユーザー    │ │翻訳      │ │認証        │
│サービス    │ │サービス  │ │サービス    │
└─────┬─────┘ └──┬──────┘ └─┬──────────┘
      │           │           │
┌─────▼───────────▼───────────▼───────────┐
│          データベース層                    │
│     (PostgreSQL / Redis / S3)            │
└──────────────────────────────────────────┘
```

<!-- mdait d68bc675 from:d68bc675 need:translate -->
## API設計

APIゲートウェイが全リクエストの認証・ルーティング・レート制限を処理する。

```javascript
const gateway = {
  plugins: ['rate-limiting', 'jwt', 'cors'],
  routes: [
    {
      path: '/api/v1/users/*',
      service: 'user-service',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    },
    {
      path: '/api/v1/translations/*',
      service: 'translation-service',
      methods: ['GET', 'POST']
    }
  ]
};
```

<!-- mdait 1d298b51 from:1d298b51 need:translate -->
### 主要エンドポイント

1. **ユーザーサービス**: `POST /users/register`, `GET /users/{id}`, `PUT /users/{id}`
2. **翻訳サービス**: `POST /translations`, `GET /translations/{id}`, `GET /translations/history`
3. **認証サービス**: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`

<!-- mdait a441910c from:a441910c need:translate -->
## データベース設計

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    plan VARCHAR(50) DEFAULT 'starter',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

<!-- mdait c246bc9d from:c246bc9d need:translate -->
## デプロイメント

<!-- mdait af5b49fb from:af5b49fb need:translate -->
### 環境構築

```bash
cp .env.example .env.production
npm run migration:run
docker-compose -f docker-compose.prod.yml up -d
curl https://api.example.com/health
```

<!-- mdait 59ab6b16 from:59ab6b16 need:translate -->
### 最近の変更

以下のdiffはv2.1.0でのAPI変更を示す。

```diff
- const API_VERSION = 'v1';
+ const API_VERSION = 'v2';

  const config = {
-   timeout: 5000,
-   retries: 2,
+   timeout: 3000,
+   retries: 3,
+   circuitBreaker: {
+     enabled: true,
+     threshold: 5
+   }
  };

> Note: v1 APIは6ヶ月間の非推奨期間後に削除予定
```

<!-- mdait 290690e1 from:290690e1 need:translate -->
## 監視とパフォーマンス

<table>
<tr><th>指標</th><th>閾値</th><th>アラート条件</th></tr>
<tr><td>エラー率</td><td>5%</td><td>5分間の平均が閾値超過</td></tr>
<tr><td>レスポンスタイム</td><td>1秒</td><td>p95が閾値超過</td></tr>
<tr><td>CPU使用率</td><td>80%</td><td>10分間の平均が閾値超過</td></tr>
<tr><td>DB接続数</td><td>プール上限の90%</td><td>即時アラート</td></tr>
</table>

<!-- mdait 656ff018 from:656ff018 need:translate -->
### キャッシング戦略

- **Redis**: セッション管理（TTL: 24h）、翻訳キャッシュ（TTL: 1h）
  - 以下のパターンでキャッシュキーを生成:

    ```
    trans:{sourceLang}:{targetLang}:{hash(sourceText)}
    ```

  > キャッシュヒット率は平均72%であり、翻訳APIコストを大幅に削減している

- **CDN**: 静的アセットをCloudFront経由で配信
- **クエリ最適化**: 複合インデックスの活用でクエリ応答時間を1.5s→0.05sに改善

<!-- mdait 2a39511d from:2a39511d need:translate -->
## セキュリティ

JWTトークン（有効期限15分）とリフレッシュトークン（7日間）による認証を実装。APIキーによる外部連携アクセス制御も併用している。
