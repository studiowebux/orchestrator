import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { cors } from "hono/cors";

// Types
interface Task {
  id: string;
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  status: "stopped" | "running" | "error" | "pending";
  containerId?: string;
  createdAt: string;
  updatedAt: string;
  autoRestart: boolean;
}

interface ContainerInfo {
  id: string;
  status: string;
  name: string;
  image: string;
}

// Container Orchestrator Class
class ContainerOrchestrator {
  private tasks: Map<string, Task> = new Map();
  private stateFile = "./orchestrator-state.json";

  constructor() {
    this.loadState();
  }

  // State persistence
  private async loadState(): Promise<void> {
    try {
      const data = await Deno.readTextFile(this.stateFile);
      const state = JSON.parse(data);
      this.tasks = new Map(Object.entries(state.tasks || {}));
      console.log(`Loaded ${this.tasks.size} tasks from state file`);
    } catch (error) {
      console.log("No existing state file found, starting fresh");
    }
  }

  private async saveState(): Promise<void> {
    const state = {
      tasks: Object.fromEntries(this.tasks.entries()),
      lastSaved: new Date().toISOString(),
    };
    await Deno.writeTextFile(this.stateFile, JSON.stringify(state, null, 2));
  }

  // Podman commands
  private async runCommand(
    cmd: string[],
  ): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      const process = new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        stdout: "piped",
        stderr: "piped",
      });

      const { code, stdout, stderr } = await process.output();
      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      return {
        success: code === 0,
        output,
        error: error || undefined,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error.message,
      };
    }
  }

  private async getContainerInfo(
    containerId: string,
  ): Promise<ContainerInfo | null> {
    const result = await this.runCommand([
      "podman",
      "inspect",
      "--format",
      "{{.Id}},{{.State.Status}},{{.Name}},{{.Config.Image}}",
      containerId,
    ]);

    if (!result.success) return null;

    const [id, status, name, image] = result.output.trim().split(",");
    return { id, status, name, image };
  }

  // Task management
  async createTask(
    taskData: Omit<Task, "id" | "createdAt" | "updatedAt" | "status">,
  ): Promise<Task> {
    const task: Task = {
      ...taskData,
      id: crypto.randomUUID(),
      status: "stopped",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    await this.saveState();
    return task;
  }

  async startTask(
    taskId: string,
  ): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, message: "Task not found" };
    }

    // Build podman run command
    const cmd = ["podman", "run", "-d", "--name", `task-${task.id}`];

    // Add ports
    if (task.ports) {
      task.ports.forEach((port) => {
        cmd.push("-p", port);
      });
    }

    // Add volumes
    if (task.volumes) {
      task.volumes.forEach((volume) => {
        cmd.push("-v", volume);
      });
    }

    // Add environment variables
    if (task.env) {
      Object.entries(task.env).forEach(([key, value]) => {
        cmd.push("-e", `${key}=${value}`);
      });
    }

    cmd.push(task.image);

    if (task.command && task.command.length > 0) {
      cmd.push(...task.command);
    }

    task.status = "pending";
    this.tasks.set(taskId, { ...task, updatedAt: new Date().toISOString() });

    const result = await this.runCommand(cmd);

    if (result.success) {
      const containerId = result.output.trim();
      task.status = "running";
      task.containerId = containerId;
      this.tasks.set(taskId, { ...task, updatedAt: new Date().toISOString() });
      await this.saveState();
      return { success: true, message: "Task started successfully" };
    } else {
      task.status = "error";
      this.tasks.set(taskId, { ...task, updatedAt: new Date().toISOString() });
      await this.saveState();
      return {
        success: false,
        message: `Failed to start task: ${result.error}`,
      };
    }
  }

  async stopTask(
    taskId: string,
  ): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, message: "Task not found" };
    }

    if (!task.containerId) {
      return { success: false, message: "No container ID found" };
    }

    const result = await this.runCommand(["podman", "stop", task.containerId]);

    if (result.success) {
      task.status = "stopped";
      this.tasks.set(taskId, { ...task, updatedAt: new Date().toISOString() });
      await this.saveState();
      return { success: true, message: "Task stopped successfully" };
    } else {
      return {
        success: false,
        message: `Failed to stop task: ${result.error}`,
      };
    }
  }

  async removeTask(
    taskId: string,
  ): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, message: "Task not found" };
    }

    // Stop container if running
    if (task.containerId && task.status === "running") {
      await this.stopTask(taskId);
    }

    // Remove container
    if (task.containerId) {
      await this.runCommand(["podman", "rm", task.containerId]);
    }

    this.tasks.delete(taskId);
    await this.saveState();
    return { success: true, message: "Task removed successfully" };
  }

  async getTaskLogs(
    taskId: string,
  ): Promise<{ success: boolean; logs?: string; message?: string }> {
    const task = this.tasks.get(taskId);
    if (!task || !task.containerId) {
      return { success: false, message: "Task or container not found" };
    }

    const result = await this.runCommand([
      "podman",
      "logs",
      "--tail",
      "100",
      task.containerId,
    ]);

    if (result.success) {
      return { success: true, logs: result.output };
    } else {
      return { success: false, message: `Failed to get logs: ${result.error}` };
    }
  }

  async restartAutoRestartTasks(): Promise<void> {
    console.log("Checking for auto-restart tasks...");

    for (const [taskId, task] of this.tasks) {
      if (task.autoRestart && task.status === "running" && task.containerId) {
        // Check if container is actually running
        const containerInfo = await this.getContainerInfo(task.containerId);

        if (!containerInfo || containerInfo.status !== "running") {
          console.log(`Restarting task ${task.name} (${taskId})`);
          await this.startTask(taskId);
        }
      }
    }
  }

  async updateTaskStatuses(): Promise<void> {
    for (const [taskId, task] of this.tasks) {
      if (task.containerId) {
        const containerInfo = await this.getContainerInfo(task.containerId);

        if (containerInfo) {
          const newStatus = containerInfo.status === "running"
            ? "running"
            : "stopped";
          if (newStatus !== task.status) {
            task.status = newStatus;
            task.updatedAt = new Date().toISOString();
            this.tasks.set(taskId, task);
          }
        }
      }
    }
    await this.saveState();
  }

  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }
}

// Initialize orchestrator
const orchestrator = new ContainerOrchestrator();

// Restart auto-restart tasks on startup
await orchestrator.restartAutoRestartTasks();

// Periodically update task statuses
setInterval(async () => {
  await orchestrator.updateTaskStatuses();
}, 10000); // Every 10 seconds

// Hono app
const app = new Hono();

app.use("*", cors());

// API Routes
app.get("/api/tasks", async (c) => {
  const tasks = orchestrator.getTasks();
  return c.json(tasks);
});

app.post("/api/tasks", async (c) => {
  try {
    const body = await c.req.json();
    const task = await orchestrator.createTask(body);
    return c.json(task, 201);
  } catch (error) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

app.get("/api/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const task = orchestrator.getTask(taskId);

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json(task);
});

app.post("/api/tasks/:id/start", async (c) => {
  const taskId = c.req.param("id");
  const result = await orchestrator.startTask(taskId);

  return c.json(result, result.success ? 200 : 400);
});

app.post("/api/tasks/:id/stop", async (c) => {
  const taskId = c.req.param("id");
  const result = await orchestrator.stopTask(taskId);

  return c.json(result, result.success ? 200 : 400);
});

app.delete("/api/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const result = await orchestrator.removeTask(taskId);

  return c.json(result, result.success ? 200 : 400);
});

app.get("/api/tasks/:id/logs", async (c) => {
  const taskId = c.req.param("id");
  const result = await orchestrator.getTaskLogs(taskId);

  if (result.success) {
    return c.json({ logs: result.logs });
  } else {
    return c.json({ error: result.message }, 400);
  }
});

// Serve static files
app.use("/static/*", serveStatic({ root: "./" }));

// Serve HTML page
app.get("/", async (c) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Container Orchestrator</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .status-running { @apply bg-green-100 text-green-800; }
        .status-stopped { @apply bg-gray-100 text-gray-800; }
        .status-error { @apply bg-red-100 text-red-800; }
        .status-pending { @apply bg-yellow-100 text-yellow-800; }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold text-gray-900 mb-8">Container Orchestrator</h1>

        <!-- Create Task Form -->
        <div class="bg-white rounded-lg shadow p-6 mb-8">
            <h2 class="text-xl font-semibold mb-4">Create New Task</h2>
            <form id="createTaskForm" class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Task Name</label>
                    <input type="text" id="taskName" class="w-full border border-gray-300 rounded-md px-3 py-2" required>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Docker Image</label>
                    <input type="text" id="taskImage" class="w-full border border-gray-300 rounded-md px-3 py-2" placeholder="nginx:latest" required>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Ports (comma-separated)</label>
                    <input type="text" id="taskPorts" class="w-full border border-gray-300 rounded-md px-3 py-2" placeholder="8080:80,8443:443">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Command (comma-separated)</label>
                    <input type="text" id="taskCommand" class="w-full border border-gray-300 rounded-md px-3 py-2" placeholder="sh,-c,echo hello">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Environment Variables</label>
                    <textarea id="taskEnv" class="w-full border border-gray-300 rounded-md px-3 py-2" placeholder="KEY1=value1&#10;KEY2=value2" rows="2"></textarea>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Volumes (comma-separated)</label>
                    <input type="text" id="taskVolumes" class="w-full border border-gray-300 rounded-md px-3 py-2" placeholder="/host/path:/container/path">
                </div>
                <div class="flex items-center">
                    <input type="checkbox" id="autoRestart" class="mr-2">
                    <label class="text-sm font-medium text-gray-700">Auto-restart on failure</label>
                </div>
                <div>
                    <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md">
                        Create Task
                    </button>
                </div>
            </form>
        </div>

        <!-- Tasks List -->
        <div class="bg-white rounded-lg shadow">
            <div class="px-6 py-4 border-b border-gray-200">
                <h2 class="text-xl font-semibold">Tasks</h2>
                <button id="refreshTasks" class="mt-2 bg-gray-600 hover:bg-gray-700 text-white font-medium py-1 px-3 rounded-md text-sm">
                    Refresh
                </button>
            </div>
            <div id="tasksList" class="divide-y divide-gray-200">
                <!-- Tasks will be loaded here -->
            </div>
        </div>

        <!-- Logs Modal -->
        <div id="logsModal" class="fixed inset-0 bg-gray-600 bg-opacity-50 hidden items-center justify-center">
            <div class="bg-white rounded-lg p-6 max-w-4xl w-full mx-4 max-h-3/4 overflow-hidden">
                <div class="flex justify-between items-center mb-4">
                    <h3 id="logsTitle" class="text-lg font-semibold">Container Logs</h3>
                    <button id="closeLogsModal" class="text-gray-500 hover:text-gray-700">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <pre id="logsContent" class="bg-black text-green-400 p-4 rounded-md overflow-auto h-96 text-sm font-mono whitespace-pre-wrap"></pre>
            </div>
        </div>
    </div>

    <script>
        let tasks = [];

        // API calls
        async function apiCall(url, options = {}) {
            try {
                const response = await fetch(url, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers
                    },
                    ...options
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Request failed');
                }

                return await response.json();
            } catch (error) {
                console.error('API call failed:', error);
                alert(error.message);
                throw error;
            }
        }

        // Load and render tasks
        async function loadTasks() {
            try {
                tasks = await apiCall('/api/tasks');
                renderTasks();
            } catch (error) {
                console.error('Failed to load tasks:', error);
            }
        }

        function renderTasks() {
            const tasksList = document.getElementById('tasksList');

            if (tasks.length === 0) {
                tasksList.innerHTML = '<div class="p-6 text-gray-500 text-center">No tasks created yet</div>';
                return;
            }

            tasksList.innerHTML = tasks.map(task => \`
                <div class="p-6">
                    <div class="flex justify-between items-start">
                        <div class="flex-1">
                            <div class="flex items-center space-x-3 mb-2">
                                <h3 class="text-lg font-medium">\${task.name}</h3>
                                <span class="px-2 py-1 text-xs font-medium rounded-full status-\${task.status}">
                                \${task.status.toUpperCase()}
                                </span>
                            </div>
                            <p class="text-gray-600 mb-2">Image: \${task.image}</p>
                            <div class="text-sm text-gray-500">
                                <p>Created: \${new Date(task.createdAt).toLocaleString()}</p>
                                <p>Updated: \${new Date(task.updatedAt).toLocaleString()}</p>
                                \${task.containerId ? \`<p>Container ID: \${task.containerId.substring(0, 12)}...</p>\` : ''}
\${task.autoRestart ? '<p>Auto-restart: Enabled</p>' : ''}
                            </div>
                        </div>
                        <div class="flex space-x-2">
                            \${task.status === 'stopped' ?
                            \`<button onclick="startTask('\${task.id}')" class="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm">Start</button>\` :
                                ''
                            }
                            \${task.status === 'running' ?
                                \`<button onclick="stopTask('\${task.id}')" class="bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded text-sm">Stop</button>\` :
                                ''
                            }
                            \${task.containerId ?
\`<button onclick="showLogs('\${task.id}', '\${task.name}')" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm">Logs</button>\` :
                                ''
                            }
                            <button onclick="removeTask('\${task.id}')" class="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm">Remove</button>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        // Task actions
        async function startTask(taskId) {
            try {
                await apiCall(\`/api/tasks/\${taskId}/start\`, { method: 'POST' });
                await loadTasks();
            } catch (error) {
                console.error('Failed to start task:', error);
            }
        }

        async function stopTask(taskId) {
            try {
                await apiCall(\`/api/tasks/\${taskId}/stop\`, { method: 'POST' });
                await loadTasks();
            } catch (error) {
                console.error('Failed to stop task:', error);
            }
        }

        async function removeTask(taskId) {
            if (!confirm('Are you sure you want to remove this task?')) return;

            try {
                await apiCall(\`/api/tasks/\${taskId}\`, { method: 'DELETE' });
                await loadTasks();
            } catch (error) {
                console.error('Failed to remove task:', error);
            }
        }

        async function showLogs(taskId, taskName) {
            try {
                const result = await apiCall(\`/api/tasks/\${taskId}/logs\`);
                document.getElementById('logsTitle').textContent = \`Logs - \${taskName}\`;
                document.getElementById('logsContent').textContent = result.logs || 'No logs available';
                document.getElementById('logsModal').classList.remove('hidden');
                document.getElementById('logsModal').classList.add('flex');
            } catch (error) {
                console.error('Failed to get logs:', error);
            }
        }

        // Form handling
        document.getElementById('createTaskForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const formData = new FormData(e.target);
            const taskData = {
                name: document.getElementById('taskName').value,
                image: document.getElementById('taskImage').value,
                autoRestart: document.getElementById('autoRestart').checked
            };

            // Parse ports
            const portsStr = document.getElementById('taskPorts').value.trim();
            if (portsStr) {
                taskData.ports = portsStr.split(',').map(p => p.trim()).filter(p => p);
            }

            // Parse command
            const commandStr = document.getElementById('taskCommand').value.trim();
            if (commandStr) {
                taskData.command = commandStr.split(',').map(c => c.trim()).filter(c => c);
            }

            // Parse volumes
            const volumesStr = document.getElementById('taskVolumes').value.trim();
            if (volumesStr) {
                taskData.volumes = volumesStr.split(',').map(v => v.trim()).filter(v => v);
            }

            // Parse environment variables
            const envStr = document.getElementById('taskEnv').value.trim();
            if (envStr) {
                taskData.env = {};
                envStr.split('\\n').forEach(line => {
                    const [key, ...valueParts] = line.split('=');
                    if (key && valueParts.length > 0) {
                        taskData.env[key.trim()] = valueParts.join('=').trim();
                    }
                });
            }

            try {
                await apiCall('/api/tasks', {
                    method: 'POST',
                    body: JSON.stringify(taskData)
                });

                e.target.reset();
                await loadTasks();
            } catch (error) {
                console.error('Failed to create task:', error);
            }
        });

        // Event listeners
        document.getElementById('refreshTasks').addEventListener('click', loadTasks);

        document.getElementById('closeLogsModal').addEventListener('click', () => {
            document.getElementById('logsModal').classList.add('hidden');
            document.getElementById('logsModal').classList.remove('flex');
        });

        // Close modal when clicking outside
        document.getElementById('logsModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('logsModal').classList.add('hidden');
                document.getElementById('logsModal').classList.remove('flex');
            }
        });

        // Load tasks on page load
        loadTasks();

        // Auto-refresh every 30 seconds
        setInterval(loadTasks, 30000);
    </script>
</body>
</html>
  `;

  return c.html(html);
});

// Start server
const port = 8080;
console.log(`Container Orchestrator starting on port ${port}...`);
console.log(`Web interface: http://localhost:${port}`);
console.log(`API endpoints: http://localhost:${port}/api/*`);

Deno.serve({ port }, app.fetch);
