import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

enum TaskType { hide, reveal }

enum TaskStatus { success, failed }

class TaskResult {
  const TaskResult({
    required this.type,
    required this.status,
    required this.command,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    required this.duration,
    required this.timestamp,
    required this.errorMessage,
  });

  final TaskType type;
  final TaskStatus status;
  final List<String> command;
  final String stdout;
  final String stderr;
  final int exitCode;
  final Duration duration;
  final DateTime timestamp;
  final String? errorMessage;
}

class ProcessRunResult {
  const ProcessRunResult({
    required this.command,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    required this.duration,
  });

  final List<String> command;
  final String stdout;
  final String stderr;
  final int exitCode;
  final Duration duration;

  bool get success => exitCode == 0;
}

class KakoProcessRunner {
  KakoProcessRunner({String? workspaceRoot}) : workspaceRoot = workspaceRoot ?? _detectWorkspaceRoot();

  final String workspaceRoot;

  static String _detectWorkspaceRoot() {
    Directory current = Directory.current.absolute;

    while (true) {
      final arm = File('${current.path}/dist/kako-macos-arm64');
      final generic = File('${current.path}/dist/kako');
      if (arm.existsSync() || generic.existsSync()) {
        return current.path;
      }

      final parent = current.parent;
      if (parent.path == current.path) {
        throw Exception(
          '未找到 Kako 工作目录。请在仓库内启动应用，或显式传入 workspaceRoot（应包含 dist/kako 可执行文件）。',
        );
      }
      current = parent;
    }
  }

  String get binaryPath {
    final arm = File('$workspaceRoot/dist/kako-macos-arm64');
    if (arm.existsSync()) {
      return arm.path;
    }
    return '$workspaceRoot/dist/kako';
  }

  Future<ProcessRunResult> run(List<String> args) async {
    final binary = File(binaryPath);
    if (!binary.existsSync()) {
      throw Exception('未找到 Kako 二进制: ${binary.path}。请先在仓库根目录执行 `bun run build`。');
    }

    final start = DateTime.now();
    final process = await Process.start(binary.path, args, runInShell: false);
    final stdoutFuture = process.stdout.transform(utf8.decoder).join();
    final stderrFuture = process.stderr.transform(utf8.decoder).join();
    final exitCode = await process.exitCode;

    return ProcessRunResult(
      command: [binary.path, ...args],
      stdout: (await stdoutFuture).trim(),
      stderr: (await stderrFuture).trim(),
      exitCode: exitCode,
      duration: DateTime.now().difference(start),
    );
  }
}

void main() {
  runApp(const KakoApp());
}

class KakoApp extends StatelessWidget {
  const KakoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kako 桌面版',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0B6E4F)),
      ),
      home: const KakoHomePage(),
    );
  }
}

class KakoHomePage extends StatefulWidget {
  const KakoHomePage({super.key});

  @override
  State<KakoHomePage> createState() => _KakoHomePageState();
}

class _KakoHomePageState extends State<KakoHomePage> {
  final _runner = KakoProcessRunner();
  final List<TaskResult> _logs = [];

  int _tabIndex = 0;

  String? _hideSecretPath;
  String? _hideHostPath;
  String? _hideOutputPath;
  bool _hideRunning = false;
  TaskResult? _hideLast;

  String? _revealInputPath;
  String? _revealOutputDir;
  bool _revealRunning = false;
  TaskResult? _revealLast;

  Future<void> _pickFile(ValueSetter<String?> onPicked, {List<String>? allowedExtensions}) async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: false,
      type: allowedExtensions == null ? FileType.any : FileType.custom,
      allowedExtensions: allowedExtensions,
    );
    if (result == null || result.files.isEmpty) {
      return;
    }
    onPicked(result.files.single.path);
  }

  Future<void> _pickDirectory(ValueSetter<String?> onPicked) async {
    final path = await FilePicker.platform.getDirectoryPath();
    if (path == null) {
      return;
    }
    onPicked(path);
  }

  String _mapError(String stderr, String fallback) {
    final text = stderr.isNotEmpty ? stderr : fallback;
    if (text.contains('unsupported host format')) {
      return '文件格式不支持，仅 JPG/JPEG/MP4。';
    }
    if (text.contains('kako metadata not found')) {
      return '未检测到可提取的隐藏数据。';
    }
    if (text.contains('payload too large for reserved mp4 slot')) {
      return 'MP4 预留空间不足，请更换宿主文件。';
    }
    if (text.contains('not found')) {
      return '执行文件或输入文件不存在，请检查路径。';
    }
    return text;
  }

  Future<void> _runHide() async {
    if (_hideRunning) {
      return;
    }
    if (_hideSecretPath == null || _hideHostPath == null || _hideOutputPath == null) {
      setState(() {
        _hideLast = TaskResult(
          type: TaskType.hide,
          status: TaskStatus.failed,
          command: const [],
          stdout: '',
          stderr: '',
          exitCode: -1,
          duration: Duration.zero,
          timestamp: DateTime.now(),
          errorMessage: '请先选择 Secret、Host 和输出文件路径。',
        );
      });
      return;
    }

    setState(() {
      _hideRunning = true;
    });

    try {
      final result = await _runner.run([
        'hide',
        '-s',
        _hideSecretPath!,
        '-h',
        _hideHostPath!,
        '-o',
        _hideOutputPath!,
      ]);

      final task = TaskResult(
        type: TaskType.hide,
        status: result.success ? TaskStatus.success : TaskStatus.failed,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration,
        timestamp: DateTime.now(),
        errorMessage: result.success ? null : _mapError(result.stderr, '隐藏任务执行失败'),
      );

      setState(() {
        _hideLast = task;
        _logs.insert(0, task);
      });
    } catch (e) {
      final task = TaskResult(
        type: TaskType.hide,
        status: TaskStatus.failed,
        command: const [],
        stdout: '',
        stderr: '$e',
        exitCode: -1,
        duration: Duration.zero,
        timestamp: DateTime.now(),
        errorMessage: _mapError('', '$e'),
      );
      setState(() {
        _hideLast = task;
        _logs.insert(0, task);
      });
    } finally {
      if (mounted) {
        setState(() {
          _hideRunning = false;
        });
      }
    }
  }

  Future<void> _runReveal() async {
    if (_revealRunning) {
      return;
    }
    if (_revealInputPath == null || _revealOutputDir == null) {
      setState(() {
        _revealLast = TaskResult(
          type: TaskType.reveal,
          status: TaskStatus.failed,
          command: const [],
          stdout: '',
          stderr: '',
          exitCode: -1,
          duration: Duration.zero,
          timestamp: DateTime.now(),
          errorMessage: '请先选择输入文件和输出目录。',
        );
      });
      return;
    }

    setState(() {
      _revealRunning = true;
    });

    try {
      final result = await _runner.run([
        'reveal',
        '-i',
        _revealInputPath!,
        '-d',
        _revealOutputDir!,
      ]);

      final task = TaskResult(
        type: TaskType.reveal,
        status: result.success ? TaskStatus.success : TaskStatus.failed,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration,
        timestamp: DateTime.now(),
        errorMessage: result.success ? null : _mapError(result.stderr, '提取任务执行失败'),
      );

      setState(() {
        _revealLast = task;
        _logs.insert(0, task);
      });
    } catch (e) {
      final task = TaskResult(
        type: TaskType.reveal,
        status: TaskStatus.failed,
        command: const [],
        stdout: '',
        stderr: '$e',
        exitCode: -1,
        duration: Duration.zero,
        timestamp: DateTime.now(),
        errorMessage: _mapError('', '$e'),
      );
      setState(() {
        _revealLast = task;
        _logs.insert(0, task);
      });
    } finally {
      if (mounted) {
        setState(() {
          _revealRunning = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      _buildHidePage(),
      _buildRevealPage(),
      _buildLogsPage(),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Kako 桌面版')),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _tabIndex,
            onDestinationSelected: (value) => setState(() => _tabIndex = value),
            labelType: NavigationRailLabelType.all,
            destinations: const [
              NavigationRailDestination(icon: Icon(Icons.visibility_off), label: Text('隐藏')),
              NavigationRailDestination(icon: Icon(Icons.visibility), label: Text('提取')),
              NavigationRailDestination(icon: Icon(Icons.article), label: Text('日志')),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: pages[_tabIndex],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPathRow({
    required String label,
    required String? value,
    required VoidCallback onPick,
    required String button,
  }) {
    return Row(
      children: [
        SizedBox(width: 130, child: Text(label)),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              border: Border.all(color: Colors.grey.shade400),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(value ?? '未选择'),
          ),
        ),
        const SizedBox(width: 12),
        FilledButton(onPressed: onPick, child: Text(button)),
      ],
    );
  }

  Widget _buildResult(TaskResult? result) {
    if (result == null) {
      return const SizedBox.shrink();
    }

    final ok = result.status == TaskStatus.success;
    final color = ok ? Colors.green.shade700 : Colors.red.shade700;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(ok ? '执行成功' : '执行失败', style: TextStyle(color: color, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text('耗时: ${result.duration.inMilliseconds}ms'),
            Text('Exit code: ${result.exitCode}'),
            if (result.errorMessage != null) Text('错误: ${result.errorMessage!}'),
            if (result.stdout.isNotEmpty) Text('输出: ${result.stdout}'),
            if (result.stderr.isNotEmpty) Text('错误输出: ${result.stderr}'),
          ],
        ),
      ),
    );
  }

  Widget _buildHidePage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('将秘密文件写入 JPG/JPEG/MP4', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),
        _buildPathRow(
          label: '秘密文件',
          value: _hideSecretPath,
          onPick: () => _pickFile((path) => setState(() => _hideSecretPath = path)),
          button: '选择',
        ),
        const SizedBox(height: 12),
        _buildPathRow(
          label: '宿主媒体',
          value: _hideHostPath,
          onPick: () => _pickFile(
            (path) => setState(() => _hideHostPath = path),
            allowedExtensions: const ['jpg', 'jpeg', 'mp4'],
          ),
          button: '选择',
        ),
        const SizedBox(height: 12),
        _buildPathRow(
          label: '输出文件',
          value: _hideOutputPath,
          onPick: () => _pickDirectory((dir) {
            if (dir == null || _hideHostPath == null) {
              return;
            }
            final ext = _hideHostPath!.toLowerCase().endsWith('.mp4') ? 'mp4' : 'jpg';
            setState(() {
              _hideOutputPath = '$dir/kako_output.$ext';
            });
          }),
          button: '选择目录',
        ),
        const SizedBox(height: 18),
        FilledButton.icon(
          onPressed: _hideRunning ? null : _runHide,
          icon: _hideRunning
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.play_arrow),
          label: Text(_hideRunning ? '执行中...' : '开始隐藏'),
        ),
        const SizedBox(height: 18),
        _buildResult(_hideLast),
      ],
    );
  }

  Widget _buildRevealPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('提取隐藏文件', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),
        _buildPathRow(
          label: '输入媒体',
          value: _revealInputPath,
          onPick: () => _pickFile(
            (path) => setState(() => _revealInputPath = path),
            allowedExtensions: const ['jpg', 'jpeg', 'mp4'],
          ),
          button: '选择',
        ),
        const SizedBox(height: 12),
        _buildPathRow(
          label: '输出目录',
          value: _revealOutputDir,
          onPick: () => _pickDirectory((path) => setState(() => _revealOutputDir = path)),
          button: '选择',
        ),
        const SizedBox(height: 18),
        FilledButton.icon(
          onPressed: _revealRunning ? null : _runReveal,
          icon: _revealRunning
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.play_arrow),
          label: Text(_revealRunning ? '执行中...' : '开始提取'),
        ),
        const SizedBox(height: 18),
        _buildResult(_revealLast),
      ],
    );
  }

  Widget _buildLogsPage() {
    if (_logs.isEmpty) {
      return const Center(child: Text('暂无日志。'));
    }

    return ListView.separated(
      itemCount: _logs.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        final item = _logs[index];
        final ok = item.status == TaskStatus.success;
        return Card(
          child: ExpansionTile(
            title: Text('${item.type == TaskType.hide ? '隐藏' : '提取'} • ${ok ? '成功' : '失败'}'),
            subtitle: Text('${item.timestamp.toLocal()} • ${item.duration.inMilliseconds}ms • exit=${item.exitCode}'),
            childrenPadding: const EdgeInsets.all(12),
            children: [
              SelectableText('命令: ${item.command.join(' ')}'),
              const SizedBox(height: 8),
              if (item.stdout.isNotEmpty) SelectableText('标准输出\n${item.stdout}'),
              if (item.stderr.isNotEmpty) SelectableText('标准错误\n${item.stderr}'),
              if (item.errorMessage != null) SelectableText('错误说明: ${item.errorMessage}'),
            ],
          ),
        );
      },
    );
  }
}
