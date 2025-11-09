# 技術ドキュメント

## システムアーキテクチャ

本システムは、マイクロサービスアーキテクチャを採用しており、以下の主要コンポーネントで構成されています。マイクロサービスアーキテクチャの採用により、各サービスの独立した開発、デプロイ、スケーリングが可能となっています。

### 全体構成

システム全体は以下の層で構成されています。

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

### APIゲートウェイ

APIゲートウェイは、クライアントからのすべてのリクエストを受け付ける単一のエントリーポイントとして機能します。認証、ルーティング、レート制限などの横断的関心事を処理します。

#### 主要機能

1. **認証・認可**: JWT トークンの検証とユーザー権限のチェック
2. **ルーティング**: リクエストを適切なマイクロサービスに振り分け
3. **レート制限**: API呼び出しの頻度制限（ユーザーごとに1分間100リクエスト）
4. **ロギング**: すべてのリクエスト/レスポンスのログ記録
5. **キャッシング**: 頻繁にアクセスされるデータのキャッシュ制御
6. **CORS処理**: クロスオリジンリクエストの管理

#### 実装詳細

```javascript
// API ゲートウェイの基本設定例
const gateway = {
  plugins: [
    'rate-limiting',
    'jwt',
    'cors',
    'request-transformer',
    'response-transformer'
  ],
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

### マイクロサービス層

各マイクロサービスは独立してデプロイ可能で、以下の原則に従って設計されています。

#### ユーザーサービス

ユーザー情報の管理を担当します。

- **責務**: ユーザー登録、プロファイル管理、認証情報の保持
- **技術スタック**: Node.js (Express)、TypeScript
- **データベース**: PostgreSQL (ユーザーテーブル)
- **エンドポイント**:
  - `POST /users/register`: 新規ユーザー登録
  - `GET /users/{id}`: ユーザー情報取得
  - `PUT /users/{id}`: ユーザー情報更新
  - `DELETE /users/{id}`: ユーザー削除

#### 翻訳サービス

翻訳処理を担当するコアサービスです。

- **責務**: テキストの翻訳、翻訳履歴の管理、用語集の適用
- **技術スタック**: Python (FastAPI)、TensorFlow
- **データベース**: PostgreSQL (翻訳履歴)、Redis (キャッシュ)
- **エンドポイント**:
  - `POST /translations`: 翻訳リクエスト
  - `GET /translations/{id}`: 翻訳結果の取得
  - `GET /translations/history`: 翻訳履歴の取得

#### 認証サービス

認証とトークン管理を担当します。

- **責務**: ログイン処理、トークン発行、トークン更新
- **技術スタック**: Node.js (Express)、jsonwebtoken
- **データベース**: Redis (トークンストア)
- **エンドポイント**:
  - `POST /auth/login`: ログイン
  - `POST /auth/refresh`: トークン更新
  - `POST /auth/logout`: ログアウト

### データベース層

PostgreSQLをメインデータベースとして使用し、Redisをキャッシュ層として配置しています。トランザクションの整合性を保ちながら、高速なデータアクセスを実現しています。

#### PostgreSQL構成

- **バージョン**: PostgreSQL 14
- **レプリケーション**: マスター1台、スレーブ2台（読み取り専用）
- **バックアップ**: 毎日フルバックアップ、継続的なWALアーカイブ
- **パーティショニング**: 翻訳履歴テーブルを月別にパーティション分割

#### 主要テーブル設計

```sql
-- ユーザーテーブル
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    plan VARCHAR(50) DEFAULT 'starter',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 翻訳履歴テーブル
CREATE TABLE translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    source_text TEXT NOT NULL,
    target_text TEXT,
    source_lang VARCHAR(10) NOT NULL,
    target_lang VARCHAR(10) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) PARTITION BY RANGE (created_at);

-- 用語集テーブル
CREATE TABLE glossaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    term_source VARCHAR(255) NOT NULL,
    term_target VARCHAR(255) NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Redis構成

- **用途**: セッション管理、APIキャッシュ、レート制限カウンタ
- **データ保持期間**: セッション（24時間）、キャッシュ（1時間）
- **クラスタ構成**: Redis Cluster（3マスター、3レプリカ）

### メッセージキュー

非同期処理のためにRabbitMQを使用しています。

- **用途**: 翻訳ジョブのキューイング、バッチ処理
- **キュー構成**:
  - `translation.high`: 優先度の高い翻訳リクエスト
  - `translation.normal`: 通常の翻訳リクエスト
  - `translation.batch`: バッチ処理用

### 監視とロギング

#### ログ管理

- **ツール**: ELK Stack (Elasticsearch, Logstash, Kibana)
- **ログレベル**: ERROR, WARN, INFO, DEBUG
- **保持期間**: 90日間

#### メトリクス監視

- **ツール**: Prometheus + Grafana
- **監視項目**:
  - CPU使用率、メモリ使用率
  - リクエスト数、レスポンスタイム
  - エラー率
  - データベース接続数

#### アラート設定

- エラー率が5%を超えた場合
- レスポンスタイムが1秒を超えた場合
- データベース接続プールが枯渇した場合
- ディスク使用率が80%を超えた場合

## デプロイメント手順

本番環境へのデプロイは、以下の手順で実施します。すべての操作はCI/CDパイプラインにより自動化されていますが、手動での実行も可能です。

### 前提条件

- Docker および Docker Compose がインストールされていること
- AWS CLI が設定済みであること
- 適切な環境変数ファイル（.env.production）が用意されていること
- データベースのバックアップが取得されていること

### デプロイ手順

1. 環境変数を設定する

```bash
# 環境変数ファイルを本番環境用に設定
cp .env.example .env.production
vi .env.production

# 必須の環境変数
# DATABASE_URL=postgresql://user:pass@host:5432/dbname
# REDIS_URL=redis://host:6379
# JWT_SECRET=your-secret-key
# AWS_ACCESS_KEY_ID=your-access-key
# AWS_SECRET_ACCESS_KEY=your-secret
```

2. データベースのマイグレーションを実行する

```bash
# マイグレーションファイルの確認
npm run migration:check

# マイグレーション実行
npm run migration:run

# マイグレーション結果の確認
npm run migration:status
```

3. Docker Composeを使用してコンテナを起動する

```bash
# イメージのビルド
docker-compose -f docker-compose.prod.yml build

# コンテナの起動
docker-compose -f docker-compose.prod.yml up -d

# 起動確認
docker-compose -f docker-compose.prod.yml ps
```

4. ヘルスチェックエンドポイントで動作確認する

```bash
# API ゲートウェイのヘルスチェック
curl https://api.example.com/health

# 各サービスのヘルスチェック
curl https://api.example.com/api/v1/users/health
curl https://api.example.com/api/v1/translations/health
curl https://api.example.com/api/v1/auth/health
```

### ロールバック手順

問題が発生した場合、以下の手順でロールバックします。

```bash
# 前バージョンのイメージタグを確認
docker images | grep production

# ロールバック実行
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --force-recreate

# データベースのロールバック（必要な場合）
npm run migration:rollback
```

### CI/CDパイプライン

GitHub Actions を使用した自動デプロイフローを構築しています。

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run tests
        run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to AWS ECS
        run: |
          aws ecs update-service \
            --cluster production \
            --service api-service \
            --force-new-deployment
```

## パフォーマンス最適化

### データベースクエリの最適化

#### インデックス設計

頻繁に検索されるカラムには適切なインデックスを設定しています。

```sql
-- ユーザーメールでの検索用
CREATE INDEX idx_users_email ON users(email);

-- 翻訳履歴の検索用
CREATE INDEX idx_translations_user_created ON translations(user_id, created_at DESC);

-- 用語集の検索用
CREATE INDEX idx_glossaries_user_term ON glossaries(user_id, term_source);
```

#### クエリのチューニング

```sql
-- 改善前: 遅いクエリ（1.5秒）
SELECT * FROM translations WHERE user_id = 'xxx' ORDER BY created_at DESC;

-- 改善後: 複合インデックスを活用（0.05秒）
SELECT id, source_text, target_text, created_at 
FROM translations 
WHERE user_id = 'xxx' 
ORDER BY created_at DESC 
LIMIT 100;
```

### キャッシング戦略

#### アプリケーションレベルキャッシュ

```javascript
// 翻訳結果のキャッシング
async function getTranslation(sourceText, sourceLang, targetLang) {
  const cacheKey = `trans:${sourceLang}:${targetLang}:${hash(sourceText)}`;
  
  // キャッシュから取得を試みる
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // キャッシュになければ翻訳実行
  const result = await translate(sourceText, sourceLang, targetLang);
  
  // 結果をキャッシュ（1時間）
  await redis.setex(cacheKey, 3600, JSON.stringify(result));
  
  return result;
}
```

#### CDNの活用

静的アセット（画像、CSS、JavaScript）はCloudFront経由で配信し、エッジロケーションでキャッシュしています。

### 非同期処理

重い処理は非同期で実行し、ユーザーへの即座のレスポンスを実現しています。

```javascript
// 大量の翻訳をバッチ処理
app.post('/api/v1/translations/batch', async (req, res) => {
  const { texts, sourceLang, targetLang } = req.body;
  
  // ジョブIDを即座に返却
  const jobId = await queue.add('translation.batch', {
    texts,
    sourceLang,
    targetLang,
    userId: req.user.id
  });
  
  res.json({ jobId, status: 'processing' });
});

// 進捗確認エンドポイント
app.get('/api/v1/translations/batch/:jobId', async (req, res) => {
  const job = await queue.getJob(req.params.jobId);
  const progress = await job.progress();
  
  res.json({ 
    jobId: req.params.jobId,
    progress,
    status: job.status
  });
});
```

## セキュリティ対策

### 認証とアクセス制御

- JWT トークンによる認証
- トークンの有効期限は15分、リフレッシュトークンは7日間
- APIキーによる外部システムからのアクセス制御

### データ保護

- データベースの暗号化（AES-256）
- 通信の暗号化（TLS 1.3）
- 個人情報のマスキング処理

### 脆弱性対策

- 依存パッケージの定期的な更新
- SQLインジェクション対策（パラメータ化クエリ）
- XSS対策（入力のサニタイズ）
- CSRF対策（トークン検証）

## トラブルシューティング

システム運用中に発生する可能性のある問題と、その対処法について説明します。

### メモリリークの調査

メモリ使用量が継続的に増加する場合は、以下の手順で調査を行ってください。

- プロファイラを使用してヒープダンプを取得する
- メモリリークの原因となるオブジェクトを特定する
- 参照が適切に解放されているか確認する

#### 詳細な調査手順

1. **ヒープダンプの取得**

```bash
# Node.js アプリケーションのヒープダンプ取得
node --inspect app.js
# Chrome DevTools でメモリプロファイルを取得
```

2. **メモリ使用量の監視**

```bash
# プロセスのメモリ使用量を継続監視
watch -n 1 'ps aux | grep node'

# より詳細な情報を取得
node --expose-gc --trace-gc app.js
```

3. **一般的な原因と対策**

- **グローバル変数の過剰使用**: スコープを限定する
- **イベントリスナーの削除漏れ**: `removeListener` を確実に呼ぶ
- **クロージャによる参照保持**: 不要な参照を `null` で解放
- **キャッシュの無限増殖**: LRUキャッシュを使用し、サイズ制限を設ける

### データベース接続エラー

```bash
# 接続数の確認
SELECT count(*) FROM pg_stat_activity;

# アイドル接続の削除
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE state = 'idle' AND state_change < now() - interval '10 minutes';

# コネクションプールの設定見直し
# config/database.js
pool: {
  min: 2,
  max: 10,
  acquireTimeoutMillis: 30000,
  idleTimeoutMillis: 30000
}
```

### パフォーマンス低下

#### スローログの分析

```bash
# PostgreSQL のスローログ確認
tail -f /var/log/postgresql/postgresql-14-main.log | grep "duration:"

# 遅いクエリの特定
SELECT query, mean_exec_time, calls 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;
```

#### ボトルネックの特定

```bash
# APMツール（New Relic / Datadog）でトレース
# CPU使用率、メモリ使用率、ディスクI/Oを確認

# Node.js のプロファイリング
node --prof app.js
node --prof-process isolate-0x*.log > profile.txt
```

## バックアップとリカバリ

### バックアップ戦略

- **フルバックアップ**: 毎日午前2時に実施
- **差分バックアップ**: 6時間ごとに実施
- **保持期間**: 30日間
- **バックアップ先**: AWS S3（別リージョンに複製）

### リストア手順

```bash
# 最新のバックアップからリストア
pg_restore -d production_db /backups/latest.dump

# 特定の時点へのリストア（PITR）
pg_restore -d production_db -t specific_timestamp /backups/base.dump
```

## スケーリング戦略

### 水平スケーリング

- Kubernetes を使用した自動スケーリング
- トラフィックに応じてPod数を動的に調整
- 最小3Pod、最大20Pod

### 垂直スケーリング

- ピーク時にはインスタンスタイプを大きくする
- 通常時: t3.medium、ピーク時: c5.xlarge

## まとめ

本ドキュメントでは、システムのアーキテクチャ、デプロイ手順、パフォーマンス最適化、セキュリティ対策、トラブルシューティングについて説明しました。運用中は定期的にログとメトリクスを確認し、問題の早期発見に努めてください。
