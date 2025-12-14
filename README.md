# mdait - Markdown AI Translator

[![CI](https://github.com/mochimochiki/mdait/actions/workflows/ci.yml/badge.svg)](https://github.com/mochimochiki/mdait/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**mdait** (Markdown AI Translator) is a powerful VS Code extension that provides AI-powered translation capabilities for Markdown documents. It intelligently manages translation workflows through unit-based processing, hash-based change detection, and comprehensive translation state tracking.

## ✨ Features

### 🔄 Smart Synchronization
- **Unit-based Processing**: Automatically divides Markdown documents into translatable units
- **Hash-based Change Detection**: Efficiently identifies changes using CRC32 hashing
- **Cross-document Sync**: Maintains consistency across multiple language versions

### 🤖 AI-Powered Translation
- **Multiple Provider Support**: 
  - VS Code Language Model API
  - Ollama (local LLM support)
- **Batch Translation**: Process multiple units efficiently
- **Translation State Tracking**: Monitor progress with visual indicators

## 🏃‍♂️ Getting Started

### 1. Configure Translation Pairs

Create a `mdait.json` file in the workspace root and configure your translation directories:

```json
// mdait.json
{
  "$schema": "./schemas/mdait-config.schema.json",
  "transPairs": [
    {
      "sourceDir": "docs/ja",
      "targetDir": "docs/en",
      "sourceLang": "ja",
      "targetLang": "en"
    }
  ]
}
```

### 2. Initialize Your Documents

1. Create your source Markdown files in the source directory
2. Open the mdait panel in the Activity Bar
3. Click the **Sync** button to create corresponding files in the target directory with translation markers

### 3. Translate Content

1. Open the mdait panel in the Activity Bar
2. View the translation status tree
3. Click the translation buttons to operate:
   - **Translate Directory** button: Process all files in a directory
   - **Translate File** button: Process a single file
   - **Translate Unit** button: Process individual units

## ⚙️ Configuration

### Translation Pairs
```json
// mdait.json
{
  "transPairs": [
    {
      "sourceDir": "content/ja",
      "targetDir": "content/en",
      "sourceLang": "ja",
      "targetLang": "en"
    }
  ]
}
```

### AI Provider Settings
```json
// mdait.json
{
  "ai": {
    "provider": "default",
    "model": "gpt-4o",
    "ollama": {
      "endpoint": "http://localhost:11434",
      "model": "gemma3"
    }
  }
}
```

### Processing Options
```json
// mdait.json
{
  "ignoredPatterns": ["**/node_modules/**", "**/.git/**"],
  "sync": {
    "autoDelete": true
  },
  "trans": {
    "markdown": {
      "skipCodeBlocks": true
    }
  }
}
```

## 🔧 AI Provider Setup

### VS Code Language Model API
mdait uses VS Code's built-in language model capabilities. Note that actual model usage requires a GitHub Copilot account.

### Ollama (Local LLM)
1. Install [Ollama](https://ollama.ai/)
2. Start Ollama server: `ollama serve`
3. Pull a model: `ollama pull gemma3`
4. Configure mdait to use Ollama in `mdait.json`:
   ```json
   {
     "ai": {
       "provider": "ollama",
       "ollama": {
         "model": "gemma3"
       }
     }
   }
   ```

## 🛠️ Development

### Prerequisites
- Node.js 20.x or higher
- VS Code 1.99.0 or higher

### Setup
```bash
# Clone the repository
git clone https://github.com/mochimochiki/mdait.git
cd mdait

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run linting
npm run lint

# Run tests
npm run test

# Watch mode for development
npm run watch
```

### Testing
The project includes comprehensive test coverage:
- Unit tests for core functionality
- Integration tests for VS Code extension features
- Sample content for testing translation workflows

```bash
npm run test
```

## 📋 Requirements

- VS Code 1.99.0 or higher
- For Ollama support: Ollama server running locally or remotely

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## 📚 Documentation

- [Design Documentation](design/design.md) - Comprehensive architecture and design details
- [Task Documentation](tasks/) - Development task tracking and implementation notes

## 🌐 Internationalization

mdait supports multiple languages:
- English (default)
- Japanese (日本語)

UI elements are localized using VS Code's l10n system.