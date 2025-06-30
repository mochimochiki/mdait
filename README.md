# mdait - Markdown AI Translator

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Extension-blue)](https://marketplace.visualstudio.com/vscode)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**mdait** (Markdown AI Translator) is a powerful VS Code extension that provides AI-powered translation capabilities for Markdown documents. It intelligently manages translation workflows through unit-based processing, hash-based change detection, and comprehensive translation state tracking.

## ✨ Features

### 🔄 Smart Synchronization
- **Unit-based Processing**: Automatically divides Markdown documents into translatable units
- **Hash-based Change Detection**: Efficiently identifies changes using CRC32 hashing
- **Cross-document Sync**: Maintains consistency across multiple language versions

### 🤖 AI-Powered Translation
- **Multiple Provider Support**: 
  - VS Code Language Model API (built-in)
  - Ollama (local LLM support)
- **Batch Translation**: Process multiple units efficiently
- **Translation State Tracking**: Monitor progress with visual indicators

### 💬 Interactive Chat
- **AI Chat Interface**: Direct interaction with language models
- **Context-aware Responses**: Leverages VS Code's LM API for relevant assistance

### 📊 Visual Status Management
- **Translation Tree View**: Hierarchical view of translation status
- **Progress Tracking**: Real-time progress indicators
- **Need-based Workflow**: Automatic flagging of units requiring attention

## 🚀 Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "mdait"
4. Click Install

## 🏃‍♂️ Getting Started

### 1. Configure Translation Pairs

Open VS Code settings and configure your translation directories:

```json
{
  "mdait.transPairs": [
    {
      "sourceDir": "docs/ja",
      "targetDir": "docs/en"
    }
  ]
}
```

### 2. Initialize Your Documents

1. Create your source Markdown files in the source directory
2. Run the **mdait: Sync** command (Ctrl+Shift+P → "mdait: Sync")
3. This will create corresponding files in the target directory with translation markers

### 3. Translate Content

1. Open the mdait panel in the Activity Bar
2. View the translation status tree
3. Use translation commands:
   - **Translate Directory**: Process all files in a directory
   - **Translate File**: Process a single file
   - **Translate Unit**: Process individual units

## ⚙️ Configuration

### Translation Pairs
```json
{
  "mdait.transPairs": [
    {
      "sourceDir": "content/ja",    // Source language directory
      "targetDir": "content/en"     // Target language directory
    }
  ]
}
```

### AI Provider Settings
```json
{
  "mdait.trans.provider": "default",              // Use VS Code LM API (recommended)
  "mdait.trans.ollama.endpoint": "http://localhost:11434",  // Ollama server URL
  "mdait.trans.ollama.model": "llama2"            // Ollama model name
}
```

### Processing Options
```json
{
  "mdait.ignoredPatterns": ["**/node_modules/**", "**/.git/**"],  // Exclude patterns
  "mdait.sync.autoDelete": true,                  // Auto-delete orphaned units
  "mdait.trans.markdown.skipCodeBlocks": true     // Skip code blocks in translation
}
```

## 🎯 Commands

| Command | Description | Shortcut |
|---------|-------------|----------|
| `mdait: Sync` | Synchronize documents and detect changes | - |
| `mdait: Translate` | Run batch translation on flagged units | - |
| `mdait: Chat` | Open AI chat interface | - |
| `mdait: Translate Directory` | Translate all units in a directory | Context menu |
| `mdait: Translate File` | Translate all units in a file | Context menu |
| `mdait: Translate Unit` | Translate a specific unit | Context menu |

## 🔧 AI Provider Setup

### VS Code Language Model API (Recommended)
No additional setup required. mdait uses VS Code's built-in language model capabilities.

### Ollama (Local LLM)
1. Install [Ollama](https://ollama.ai/)
2. Start Ollama server: `ollama serve`
3. Pull a model: `ollama pull llama2`
4. Configure mdait to use Ollama:
   ```json
   {
     "mdait.trans.provider": "ollama",
     "mdait.trans.ollama.model": "llama2"
   }
   ```

## 📖 How It Works

### mdaitUnit Concept
mdait processes documents by dividing them into **mdaitUnits** - logical translation segments marked with HTML comments:

```markdown
<!-- mdait 3f7c8a1b from:2d5e9c4f need:translate -->
This paragraph needs translation from the source document.
```

**Marker Components:**
- `hash`: Content hash for change detection (8-char CRC32)
- `from`: Source unit hash for translation tracking (optional)
- `need`: Action flags (`translate`, `review`, `verify-deletion`, etc.)

### Workflow
1. **Sync**: Analyze documents, create units, detect changes
2. **Translate**: Process units marked with `need:translate`
3. **Review**: Handle units requiring human attention
4. **Maintain**: Keep translation pairs synchronized

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│                UI Layer                  │ ← VS Code Integration
├─────────────────────────────────────────┤
│              Commands Layer              │ ← sync/trans/chat
├─────────────────────────────────────────┤  
│                Core Layer                │ ← Units, Hash, Status
├─────────────────────────────────────────┤
│      Config    │    API     │   Utils    │ ← Configuration & Services
└─────────────────────────────────────────┘
```

For detailed architecture information, see [design.md](design.md).

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

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes following our coding standards
4. Add tests for new functionality
5. Run the test suite: `npm run test`
6. Commit your changes: `git commit -m 'Add amazing feature'`
7. Push to the branch: `git push origin feature/amazing-feature`
8. Open a Pull Request

### Development Guidelines
- Follow TypeScript best practices
- Use existing code patterns and naming conventions
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting

## 📋 Requirements

- VS Code 1.99.0 or higher
- For Ollama support: Ollama server running locally or remotely

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## 📚 Documentation

- [Design Documentation](design.md) - Comprehensive architecture and design details
- [Task Documentation](tasks/) - Development task tracking and implementation notes

## 🌐 Internationalization

mdait supports multiple languages:
- English (default)
- Japanese (日本語)

UI elements are localized using VS Code's l10n system.

---

**Made with ❤️ for the developer community**