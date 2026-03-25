import { db, usersTable, configsTable, nodesTable, subtopicContentsTable, subtopicQuestionsTable } from "@workspace/db";
import { hash } from "bcrypt";

const DEFAULT_PASSWORD = "1234567890";

async function seed() {
  console.log("Seeding database...");

  const hashedPassword = await hash(DEFAULT_PASSWORD, 10);

  await db.insert(usersTable).values([
    { id: "STU001", universityId: "uni1", branch: "CSE", year: "3", role: "student", password: hashedPassword },
    { id: "STU002", universityId: "uni1", branch: "ECE", year: "2", role: "student", password: hashedPassword },
    { id: "STU003", universityId: "uni2", branch: "CSE", year: "4", role: "student", password: hashedPassword },
    { id: "ADMIN", universityId: "uni1", branch: "CSE", year: "3", role: "admin", password: hashedPassword },
  ]).onConflictDoNothing();

  await db.insert(configsTable).values([
    { id: "cfg1", universityId: "uni1", year: "3", branch: "CSE", subject: "Data Structures", exam: "mid1", status: "live", createdBy: "ADMIN" },
    { id: "cfg2", universityId: "uni1", year: "3", branch: "CSE", subject: "Data Structures", exam: "mid2", status: "live", createdBy: "ADMIN" },
    { id: "cfg3", universityId: "uni1", year: "3", branch: "CSE", subject: "Operating Systems", exam: "mid1", status: "live", createdBy: "ADMIN" },
    { id: "cfg4", universityId: "uni1", year: "3", branch: "ECE", subject: "Digital Electronics", exam: "mid1", status: "live", createdBy: "ADMIN" },
    { id: "cfg5", universityId: "uni2", year: "4", branch: "CSE", subject: "Machine Learning", exam: "endsem", status: "live", createdBy: "ADMIN" },
    { id: "cfg6", universityId: "uni1", year: "3", branch: "CSE", subject: "DBMS", exam: "mid1", status: "draft", createdBy: "ADMIN" },
  ]).onConflictDoNothing();

  await db.insert(nodesTable).values([
    { id: "u1", configId: "cfg1", title: "Unit 1: Introduction to Data Structures", type: "unit", parentId: null, sortOrder: "1" },
    { id: "u2", configId: "cfg1", title: "Unit 2: Trees and Graphs", type: "unit", parentId: null, sortOrder: "2" },

    { id: "t1", configId: "cfg1", title: "Arrays and Linked Lists", type: "topic", parentId: "u1", sortOrder: "1" },
    { id: "t2", configId: "cfg1", title: "Stacks and Queues", type: "topic", parentId: "u1", sortOrder: "2" },
    { id: "t3", configId: "cfg1", title: "Binary Trees", type: "topic", parentId: "u2", sortOrder: "1" },
    { id: "t4", configId: "cfg1", title: "Graph Algorithms", type: "topic", parentId: "u2", sortOrder: "2" },

    { id: "s1", configId: "cfg1", title: "Array Operations", type: "subtopic", parentId: "t1", sortOrder: "1" },
    { id: "s2", configId: "cfg1", title: "Singly Linked List", type: "subtopic", parentId: "t1", sortOrder: "2" },
    { id: "s3", configId: "cfg1", title: "Doubly Linked List", type: "subtopic", parentId: "t1", sortOrder: "3" },
    { id: "s4", configId: "cfg1", title: "Stack Implementation", type: "subtopic", parentId: "t2", sortOrder: "1" },
    { id: "s5", configId: "cfg1", title: "Queue Implementation", type: "subtopic", parentId: "t2", sortOrder: "2" },
    { id: "s6", configId: "cfg1", title: "Binary Tree Traversals", type: "subtopic", parentId: "t3", sortOrder: "1" },
    { id: "s7", configId: "cfg1", title: "BST Operations", type: "subtopic", parentId: "t3", sortOrder: "2" },
    { id: "s8", configId: "cfg1", title: "BFS and DFS", type: "subtopic", parentId: "t4", sortOrder: "1" },
    { id: "s9", configId: "cfg1", title: "Shortest Path Algorithms", type: "subtopic", parentId: "t4", sortOrder: "2" },

    { id: "u3", configId: "cfg3", title: "Unit 1: Process Management", type: "unit", parentId: null, sortOrder: "1" },
    { id: "t5", configId: "cfg3", title: "Process Scheduling", type: "topic", parentId: "u3", sortOrder: "1" },
    { id: "s10", configId: "cfg3", title: "FCFS Scheduling", type: "subtopic", parentId: "t5", sortOrder: "1" },
    { id: "s11", configId: "cfg3", title: "Round Robin Scheduling", type: "subtopic", parentId: "t5", sortOrder: "2" },
  ]).onConflictDoNothing();

  await db.insert(subtopicContentsTable).values([
    { id: "sc1", nodeId: "s1", explanation: "Arrays are a fundamental data structure that store elements in contiguous memory locations. Each element can be accessed directly using its index, providing O(1) access time. Arrays have a fixed size once created (in most languages), and support operations like insertion, deletion, searching, and sorting. The key advantage of arrays is their cache-friendly memory layout, which makes sequential access very fast." },
    { id: "sc2", nodeId: "s2", explanation: "A singly linked list is a linear data structure where each element (node) contains data and a pointer to the next node. The last node points to null. Unlike arrays, linked lists do not require contiguous memory allocation. They allow efficient insertion and deletion at the beginning in O(1) time." },
    { id: "sc3", nodeId: "s3", explanation: "A doubly linked list is similar to a singly linked list but each node has two pointers: one to the next node and one to the previous node. This allows traversal in both directions. The first node's previous pointer and the last node's next pointer both point to null." },
    { id: "sc4", nodeId: "s4", explanation: "A stack is a linear data structure that follows the Last In, First Out (LIFO) principle. The last element added to the stack is the first one to be removed. Main operations are push (add element to top), pop (remove element from top), and peek (view top element without removing). Stacks can be implemented using arrays or linked lists." },
    { id: "sc5", nodeId: "s5", explanation: "A queue is a linear data structure that follows the First In, First Out (FIFO) principle. Elements are added at the rear (enqueue) and removed from the front (dequeue). Queues are used in scheduling, BFS traversal, and buffer management." },
    { id: "sc6", nodeId: "s6", explanation: "Binary tree traversal is the process of visiting all nodes in a binary tree in a specific order. There are three main depth-first traversals: Inorder (Left, Root, Right), Preorder (Root, Left, Right), and Postorder (Left, Right, Root). There is also Breadth-First traversal (Level Order) which visits nodes level by level." },
    { id: "sc7", nodeId: "s7", explanation: "A Binary Search Tree (BST) is a binary tree where for each node, all elements in the left subtree are smaller and all elements in the right subtree are greater. This property enables efficient searching, insertion, and deletion operations with average time complexity of O(log n)." },
    { id: "sc8", nodeId: "s8", explanation: "BFS (Breadth-First Search) and DFS (Depth-First Search) are fundamental graph traversal algorithms. BFS explores all neighbors at the current depth before moving to the next level, using a queue. DFS explores as far as possible along each branch before backtracking, using a stack or recursion." },
    { id: "sc9", nodeId: "s9", explanation: "Shortest path algorithms find the minimum cost path between nodes in a graph. Dijkstra's algorithm works for non-negative weights, while Bellman-Ford handles negative weights. Floyd-Warshall finds shortest paths between all pairs of vertices." },
    { id: "sc10", nodeId: "s10", explanation: "First Come First Served (FCFS) is the simplest CPU scheduling algorithm. Processes are executed in the order they arrive in the ready queue. It is a non-preemptive algorithm, meaning once a process starts executing, it runs to completion." },
    { id: "sc11", nodeId: "s11", explanation: "Round Robin (RR) scheduling assigns a fixed time quantum to each process. The CPU cycles through all processes in the ready queue, giving each process a time slice. If a process doesn't finish within its quantum, it is preempted and moved to the back of the queue." },
  ]).onConflictDoNothing();

  await db.insert(subtopicQuestionsTable).values([
    { nodeId: "s1", markType: "2", question: "What is the time complexity of accessing an element in an array by index?", answer: "The time complexity of accessing an element in an array by index is O(1), which is constant time. This is because arrays store elements in contiguous memory locations, so the address of any element can be calculated directly using the base address and the index." },
    { nodeId: "s1", markType: "5", question: "Explain the differences between arrays and linked lists in terms of memory allocation, access time, insertion, and deletion operations.", answer: "Arrays vs Linked Lists:\n\n1. Memory Allocation: Arrays use contiguous memory allocation. Linked lists use dynamic memory allocation with pointers.\n\n2. Access Time: Arrays provide O(1) random access. Linked lists require O(n) traversal.\n\n3. Insertion: Arrays O(n) due to shifting. Linked lists O(1) if position known.\n\n4. Deletion: Arrays O(n) due to shifting. Linked lists O(1) if pointer available.\n\n5. Memory Overhead: Arrays have no extra overhead. Linked lists need pointer storage per node." },

    { nodeId: "s2", markType: "2", question: "What are the main components of a node in a singly linked list?", answer: "A node in a singly linked list has two components: (1) Data field - stores the actual value/element, and (2) Next pointer - stores the address/reference of the next node in the list. The last node's next pointer is null." },
    { nodeId: "s2", markType: "5", question: "Write and explain the algorithm for inserting a new node at the beginning, end, and a specific position in a singly linked list.", answer: "Insertion in Singly Linked List:\n\n1. At Beginning: Create node, set next to head, update head. O(1)\n\n2. At End: Create node, traverse to last, set last.next to new node. O(n)\n\n3. At Position: Traverse to position-1, set new node's next to current.next, set current.next to new node. O(n)" },

    { nodeId: "s3", markType: "2", question: "What advantage does a doubly linked list have over a singly linked list?", answer: "A doubly linked list allows traversal in both forward and backward directions, making operations like deletion of a given node O(1) if we have a pointer to it. It also supports reverse traversal." },
    { nodeId: "s3", markType: "5", question: "Explain the structure of a doubly linked list and describe the algorithm for deletion of a node from any position.", answer: "Each node has three fields: prev pointer, data, and next pointer.\n\nDeletion:\n1. From Beginning: Update head to head.next, set new head.prev to null. O(1)\n2. From End: Traverse to last, update second-to-last.next to null. O(n) or O(1) with tail.\n3. From Position: Set node.prev.next = node.next, node.next.prev = node.prev. O(n) traversal + O(1) deletion." },

    { nodeId: "s4", markType: "2", question: "Define stack and list its basic operations.", answer: "A stack is a linear data structure following LIFO (Last In, First Out) principle. Basic operations: Push (insert at top), Pop (remove from top), Peek/Top (view top element), isEmpty (check if empty), isFull (check if full)." },
    { nodeId: "s4", markType: "5", question: "Explain stack implementation using arrays. Include push and pop operations with overflow and underflow conditions.", answer: "Stack using Arrays:\n\nStructure: Fixed-size array + top variable (initialized to -1).\n\nPush: Check overflow (top == MAX-1), increment top, store element. O(1)\nPop: Check underflow (top == -1), retrieve element, decrement top. O(1)\nPeek: Check empty, return array[top]. O(1)\n\nAdvantages: Simple, O(1) ops.\nDisadvantages: Fixed size, overflow possible." },

    { nodeId: "s5", markType: "2", question: "What is the difference between a stack and a queue?", answer: "Stack follows LIFO (Last In First Out). Queue follows FIFO (First In First Out). Stack uses push/pop; Queue uses enqueue/dequeue." },
    { nodeId: "s5", markType: "5", question: "Explain circular queue and its advantages over linear queue. Describe enqueue and dequeue operations.", answer: "Circular Queue: Last position connects back to first, forming a circle.\n\nAdvantages: Reuses freed space that linear queue wastes.\n\nEnqueue: Check full ((rear+1)%MAX == front), update rear = (rear+1)%MAX, store element. O(1)\nDequeue: Check empty (front == -1), retrieve, if front==rear reset both to -1, else front = (front+1)%MAX. O(1)" },

    { nodeId: "s6", markType: "2", question: "List the three types of depth-first binary tree traversals.", answer: "Inorder (Left, Root, Right), Preorder (Root, Left, Right), and Postorder (Left, Right, Root)." },
    { nodeId: "s6", markType: "5", question: "Given a binary tree, explain all three depth-first traversal methods with examples and their applications.", answer: "1. Inorder (L, Root, R): Produces sorted output for BST. O(n)\n2. Preorder (Root, L, R): Used to create tree copies, prefix expressions. O(n)\n3. Postorder (L, R, Root): Used for tree deletion, postfix expressions. O(n)\n\nSpace: O(h) where h = tree height." },

    { nodeId: "s7", markType: "2", question: "What is the BST property?", answer: "For every node: all left subtree values are less than the node's value, all right subtree values are greater. This holds for every node in the tree." },
    { nodeId: "s7", markType: "5", question: "Explain the search, insert, and delete operations in a BST with their time complexities.", answer: "Search: Compare key with root, go left if smaller, right if larger. Avg O(log n), Worst O(n).\nInsert: Traverse to correct null position, insert. Avg O(log n), Worst O(n).\nDelete: Leaf - remove. One child - replace with child. Two children - replace with inorder successor, delete successor. Avg O(log n), Worst O(n)." },

    { nodeId: "s8", markType: "2", question: "What data structures are used for BFS and DFS traversal?", answer: "BFS uses a Queue (FIFO). DFS uses a Stack (explicitly or via recursion's call stack, LIFO)." },
    { nodeId: "s8", markType: "5", question: "Compare BFS and DFS in terms of algorithm, space complexity, and applications.", answer: "BFS: Uses queue, explores level by level. Finds shortest path in unweighted graphs. Space O(V). Time O(V+E).\nDFS: Uses stack/recursion, explores depth first. Space O(V). Time O(V+E).\n\nBFS apps: Shortest path, level-order.\nDFS apps: Topological sort, cycle detection, path finding." },

    { nodeId: "s9", markType: "2", question: "Name two shortest path algorithms and their key difference.", answer: "Dijkstra's (non-negative weights only, O(V²) or O(E log V)) and Bellman-Ford (handles negative weights, O(VE))." },
    { nodeId: "s9", markType: "5", question: "Explain Dijkstra's shortest path algorithm with an example. What are its limitations?", answer: "Initialize source distance 0, others infinity. Greedily pick min-distance unvisited vertex, update neighbors. Repeat.\n\nLimitations: Cannot handle negative edge weights or negative cycles." },

    { nodeId: "s10", markType: "2", question: "What are the disadvantages of FCFS scheduling?", answer: "Convoy effect, high average waiting time, non-preemptive blocking, not suitable for time-sharing systems." },
    { nodeId: "s10", markType: "5", question: "Explain FCFS scheduling with a numerical example. Calculate average waiting time and turnaround time.", answer: "FCFS: Execute in arrival order.\n\nExample (arrival 0): P1=24ms, P2=3ms, P3=3ms\nGantt: |P1|P2|P3| at 0,24,27,30\nWT: P1=0, P2=24, P3=27. Avg = 17ms\nTAT: P1=24, P2=27, P3=30. Avg = 27ms\n\nConvoy effect: Short processes wait behind long ones." },

    { nodeId: "s11", markType: "2", question: "What is a time quantum in Round Robin scheduling?", answer: "A fixed time slice each process gets on the CPU. When expired, the process is preempted and placed at the end of the ready queue." },
    { nodeId: "s11", markType: "5", question: "Explain Round Robin scheduling. How does the choice of time quantum affect performance?", answer: "Circular ready queue with fixed quantum q. If burst <= q, complete. If burst > q, preempt, move to end.\n\nLarge q → degenerates to FCFS. Small q → too many context switches.\nOptimal: 80% of bursts shorter than q.\n\nAdvantages: Fair, good response time, no starvation." },
  ]).onConflictDoNothing();

  console.log("Seeding complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
