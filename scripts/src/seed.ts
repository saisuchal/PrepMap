import { db, usersTable, configsTable, nodesTable, subtopicContentsTable } from "@workspace/db";

async function seed() {
  console.log("Seeding database...");

  await db.insert(usersTable).values([
    { id: "STU001", universityId: "uni1", branch: "CSE", year: "3" },
    { id: "STU002", universityId: "uni1", branch: "ECE", year: "2" },
    { id: "STU003", universityId: "uni2", branch: "CSE", year: "4" },
    { id: "ADMIN", universityId: "uni1", branch: "CSE", year: "3" },
  ]).onConflictDoNothing();

  await db.insert(configsTable).values([
    { id: "cfg1", universityId: "uni1", year: "3", branch: "CSE", subject: "Data Structures", exam: "mid1", isActive: true },
    { id: "cfg2", universityId: "uni1", year: "3", branch: "CSE", subject: "Data Structures", exam: "mid2", isActive: true },
    { id: "cfg3", universityId: "uni1", year: "3", branch: "CSE", subject: "Operating Systems", exam: "mid1", isActive: true },
    { id: "cfg4", universityId: "uni1", year: "3", branch: "ECE", subject: "Digital Electronics", exam: "mid1", isActive: true },
    { id: "cfg5", universityId: "uni2", year: "4", branch: "CSE", subject: "Machine Learning", exam: "endsem", isActive: true },
    { id: "cfg6", universityId: "uni1", year: "3", branch: "CSE", subject: "DBMS", exam: "mid1", isActive: false },
  ]).onConflictDoNothing();

  await db.insert(nodesTable).values([
    { id: "u1", configId: "cfg1", title: "Unit 1: Introduction to Data Structures", type: "unit", parentId: null },
    { id: "u2", configId: "cfg1", title: "Unit 2: Trees and Graphs", type: "unit", parentId: null },

    { id: "t1", configId: "cfg1", title: "Arrays and Linked Lists", type: "topic", parentId: "u1" },
    { id: "t2", configId: "cfg1", title: "Stacks and Queues", type: "topic", parentId: "u1" },
    { id: "t3", configId: "cfg1", title: "Binary Trees", type: "topic", parentId: "u2" },
    { id: "t4", configId: "cfg1", title: "Graph Algorithms", type: "topic", parentId: "u2" },

    { id: "s1", configId: "cfg1", title: "Array Operations", type: "subtopic", parentId: "t1" },
    { id: "s2", configId: "cfg1", title: "Singly Linked List", type: "subtopic", parentId: "t1" },
    { id: "s3", configId: "cfg1", title: "Doubly Linked List", type: "subtopic", parentId: "t1" },
    { id: "s4", configId: "cfg1", title: "Stack Implementation", type: "subtopic", parentId: "t2" },
    { id: "s5", configId: "cfg1", title: "Queue Implementation", type: "subtopic", parentId: "t2" },
    { id: "s6", configId: "cfg1", title: "Binary Tree Traversals", type: "subtopic", parentId: "t3" },
    { id: "s7", configId: "cfg1", title: "BST Operations", type: "subtopic", parentId: "t3" },
    { id: "s8", configId: "cfg1", title: "BFS and DFS", type: "subtopic", parentId: "t4" },
    { id: "s9", configId: "cfg1", title: "Shortest Path Algorithms", type: "subtopic", parentId: "t4" },

    { id: "u3", configId: "cfg3", title: "Unit 1: Process Management", type: "unit", parentId: null },
    { id: "t5", configId: "cfg3", title: "Process Scheduling", type: "topic", parentId: "u3" },
    { id: "s10", configId: "cfg3", title: "FCFS Scheduling", type: "subtopic", parentId: "t5" },
    { id: "s11", configId: "cfg3", title: "Round Robin Scheduling", type: "subtopic", parentId: "t5" },
  ]).onConflictDoNothing();

  await db.insert(subtopicContentsTable).values([
    {
      id: "sc1", nodeId: "s1",
      explanation: "Arrays are a fundamental data structure that store elements in contiguous memory locations. Each element can be accessed directly using its index, providing O(1) access time. Arrays have a fixed size once created (in most languages), and support operations like insertion, deletion, searching, and sorting. The key advantage of arrays is their cache-friendly memory layout, which makes sequential access very fast.",
      twoMarkQuestion: "What is the time complexity of accessing an element in an array by index?",
      twoMarkAnswer: "The time complexity of accessing an element in an array by index is O(1), which is constant time. This is because arrays store elements in contiguous memory locations, so the address of any element can be calculated directly using the base address and the index.",
      fiveMarkQuestion: "Explain the differences between arrays and linked lists in terms of memory allocation, access time, insertion, and deletion operations.",
      fiveMarkAnswer: "Arrays vs Linked Lists:\n\n1. Memory Allocation: Arrays use contiguous memory allocation, meaning all elements are stored in adjacent memory locations. Linked lists use dynamic memory allocation, where each node can be stored anywhere in memory and contains a pointer to the next node.\n\n2. Access Time: Arrays provide O(1) random access using index. Linked lists require O(n) time for accessing an element as you must traverse from the head.\n\n3. Insertion: In arrays, insertion at a specific position takes O(n) time because elements need to be shifted. In linked lists, insertion takes O(1) time if we have a pointer to the position (plus O(n) to find the position).\n\n4. Deletion: Similar to insertion, deletion in arrays requires shifting elements taking O(n) time. In linked lists, deletion takes O(1) if we have a pointer to the node to be deleted.\n\n5. Memory Overhead: Arrays have no extra memory overhead per element. Linked lists require extra memory for storing pointers in each node.",
    },
    {
      id: "sc2", nodeId: "s2",
      explanation: "A singly linked list is a linear data structure where each element (node) contains data and a pointer to the next node. The last node points to null. Unlike arrays, linked lists do not require contiguous memory allocation. They allow efficient insertion and deletion at the beginning in O(1) time.",
      twoMarkQuestion: "What are the main components of a node in a singly linked list?",
      twoMarkAnswer: "A node in a singly linked list has two components: (1) Data field - stores the actual value/element, and (2) Next pointer - stores the address/reference of the next node in the list. The last node's next pointer is null.",
      fiveMarkQuestion: "Write and explain the algorithm for inserting a new node at the beginning, end, and a specific position in a singly linked list.",
      fiveMarkAnswer: "Insertion in Singly Linked List:\n\n1. Insertion at Beginning:\n- Create a new node with the given data\n- Set the next pointer of the new node to the current head\n- Update the head to point to the new node\n- Time Complexity: O(1)\n\n2. Insertion at End:\n- Create a new node with the given data\n- If list is empty, make the new node the head\n- Otherwise, traverse to the last node\n- Set the next pointer of the last node to the new node\n- Set the next pointer of the new node to null\n- Time Complexity: O(n)\n\n3. Insertion at Specific Position (after a given node):\n- Create a new node with the given data\n- Traverse to the node at position-1\n- Set the next pointer of the new node to the next of the current node\n- Set the next pointer of the current node to the new node\n- Time Complexity: O(n) for traversal + O(1) for insertion",
    },
    {
      id: "sc3", nodeId: "s3",
      explanation: "A doubly linked list is similar to a singly linked list but each node has two pointers: one to the next node and one to the previous node. This allows traversal in both directions. The first node's previous pointer and the last node's next pointer both point to null.",
      twoMarkQuestion: "What advantage does a doubly linked list have over a singly linked list?",
      twoMarkAnswer: "A doubly linked list allows traversal in both forward and backward directions, making operations like deletion of a given node O(1) if we have a pointer to it (no need to find the previous node). It also supports reverse traversal which is not possible in a singly linked list.",
      fiveMarkQuestion: "Explain the structure of a doubly linked list and describe the algorithm for deletion of a node from any position.",
      fiveMarkAnswer: "Doubly Linked List Structure:\nEach node contains three fields:\n1. Previous pointer - points to the previous node\n2. Data - stores the element value\n3. Next pointer - points to the next node\n\nDeletion Algorithm:\n\n1. Deletion from Beginning:\n- If list is empty, return error\n- Store reference to head node\n- Update head to head.next\n- If new head exists, set new head.prev to null\n- Free the old head node\n- Time: O(1)\n\n2. Deletion from End:\n- If list is empty, return error\n- Traverse to the last node\n- Set the next pointer of second-to-last node to null\n- Free the last node\n- Time: O(n) or O(1) with tail pointer\n\n3. Deletion from Specific Position:\n- Traverse to the node to be deleted\n- Set node.prev.next = node.next\n- Set node.next.prev = node.prev\n- Free the node\n- Time: O(n) for traversal + O(1) for deletion",
    },
    {
      id: "sc4", nodeId: "s4",
      explanation: "A stack is a linear data structure that follows the Last In, First Out (LIFO) principle. The last element added to the stack is the first one to be removed. Main operations are push (add element to top), pop (remove element from top), and peek (view top element without removing). Stacks can be implemented using arrays or linked lists.",
      twoMarkQuestion: "Define stack and list its basic operations.",
      twoMarkAnswer: "A stack is a linear data structure following LIFO (Last In, First Out) principle. Basic operations: Push (insert at top), Pop (remove from top), Peek/Top (view top element), isEmpty (check if stack is empty), isFull (check if stack is full - for array implementation).",
      fiveMarkQuestion: "Explain stack implementation using arrays. Include push and pop operations with overflow and underflow conditions.",
      fiveMarkAnswer: "Stack Implementation using Arrays:\n\nStructure:\n- An array of fixed size to store elements\n- A variable 'top' initialized to -1 indicating empty stack\n\nPush Operation:\n1. Check if stack is full (top == MAX_SIZE - 1)\n2. If full, throw Stack Overflow error\n3. Increment top by 1\n4. Store the element at array[top]\n5. Time Complexity: O(1)\n\nPop Operation:\n1. Check if stack is empty (top == -1)\n2. If empty, throw Stack Underflow error\n3. Store the element at array[top]\n4. Decrement top by 1\n5. Return the stored element\n6. Time Complexity: O(1)\n\nPeek Operation:\n1. Check if stack is empty\n2. If empty, throw error\n3. Return array[top] without modifying top\n4. Time Complexity: O(1)\n\nAdvantages: Simple implementation, O(1) operations\nDisadvantages: Fixed size, possible overflow",
    },
    {
      id: "sc5", nodeId: "s5",
      explanation: "A queue is a linear data structure that follows the First In, First Out (FIFO) principle. Elements are added at the rear (enqueue) and removed from the front (dequeue). Queues are used in scheduling, BFS traversal, and buffer management.",
      twoMarkQuestion: "What is the difference between a stack and a queue?",
      twoMarkAnswer: "Stack follows LIFO (Last In First Out) - the last element added is removed first. Queue follows FIFO (First In First Out) - the first element added is removed first. Stack uses push/pop operations; Queue uses enqueue/dequeue operations.",
      fiveMarkQuestion: "Explain circular queue and its advantages over linear queue. Describe enqueue and dequeue operations.",
      fiveMarkAnswer: "Circular Queue:\nA circular queue is a linear data structure where the last position is connected back to the first position, forming a circle.\n\nAdvantages over Linear Queue:\n1. Overcomes the problem of wasted space in linear queue\n2. In linear queue, even after dequeue operations free up space at the front, new elements cannot be added if rear is at the end\n3. Circular queue reuses the freed spaces by wrapping around\n\nEnqueue Operation:\n1. Check if queue is full: (rear + 1) % MAX_SIZE == front\n2. If full, throw Queue Overflow\n3. If queue is empty, set front = 0\n4. rear = (rear + 1) % MAX_SIZE\n5. array[rear] = element\n6. Time: O(1)\n\nDequeue Operation:\n1. Check if queue is empty: front == -1\n2. If empty, throw Queue Underflow\n3. element = array[front]\n4. If front == rear, reset both to -1 (queue becomes empty)\n5. Else, front = (front + 1) % MAX_SIZE\n6. Return element\n7. Time: O(1)",
    },
    {
      id: "sc6", nodeId: "s6",
      explanation: "Binary tree traversal is the process of visiting all nodes in a binary tree in a specific order. There are three main depth-first traversals: Inorder (Left, Root, Right), Preorder (Root, Left, Right), and Postorder (Left, Right, Root). There is also Breadth-First traversal (Level Order) which visits nodes level by level.",
      twoMarkQuestion: "List the three types of depth-first binary tree traversals.",
      twoMarkAnswer: "The three types of depth-first binary tree traversals are: (1) Inorder (Left, Root, Right), (2) Preorder (Root, Left, Right), and (3) Postorder (Left, Right, Root).",
      fiveMarkQuestion: "Given a binary tree, explain all three depth-first traversal methods with examples and their applications.",
      fiveMarkAnswer: "Binary Tree Traversals:\n\n1. Inorder Traversal (Left, Root, Right):\n- Recursively traverse left subtree\n- Visit the root node\n- Recursively traverse right subtree\n- Application: Produces sorted output for BST\n- Example for tree [1,2,3,4,5]: Output: 4,2,5,1,3\n\n2. Preorder Traversal (Root, Left, Right):\n- Visit the root node\n- Recursively traverse left subtree\n- Recursively traverse right subtree\n- Application: Used to create a copy of the tree, prefix expression evaluation\n- Example: Output: 1,2,4,5,3\n\n3. Postorder Traversal (Left, Right, Root):\n- Recursively traverse left subtree\n- Recursively traverse right subtree\n- Visit the root node\n- Application: Used for deletion of tree, postfix expression evaluation\n- Example: Output: 4,5,2,3,1\n\nTime Complexity: O(n) for all traversals\nSpace Complexity: O(h) where h is the height of tree",
    },
    {
      id: "sc7", nodeId: "s7",
      explanation: "A Binary Search Tree (BST) is a binary tree where for each node, all elements in the left subtree are smaller and all elements in the right subtree are greater. This property enables efficient searching, insertion, and deletion operations with average time complexity of O(log n).",
      twoMarkQuestion: "What is the BST property?",
      twoMarkAnswer: "The BST property states that for every node in the tree: (1) All values in the left subtree are less than the node's value, and (2) All values in the right subtree are greater than the node's value. This property must hold for every node in the tree.",
      fiveMarkQuestion: "Explain the search, insert, and delete operations in a BST with their time complexities.",
      fiveMarkAnswer: "BST Operations:\n\n1. Search Operation:\n- Compare key with root\n- If equal, found the node\n- If key < root, search in left subtree\n- If key > root, search in right subtree\n- Average: O(log n), Worst: O(n)\n\n2. Insert Operation:\n- Start from root, compare with key\n- If key < current node, go left\n- If key > current node, go right\n- When reaching a null position, insert the new node\n- Average: O(log n), Worst: O(n)\n\n3. Delete Operation (three cases):\n- Node is a leaf: Simply remove it\n- Node has one child: Replace node with its child\n- Node has two children: Find inorder successor (smallest in right subtree), replace node's value with successor's value, delete the successor\n- Average: O(log n), Worst: O(n)\n\nWorst case O(n) occurs when tree is skewed (all nodes in one direction, like a linked list).",
    },
    {
      id: "sc8", nodeId: "s8",
      explanation: "BFS (Breadth-First Search) and DFS (Depth-First Search) are fundamental graph traversal algorithms. BFS explores all neighbors at the current depth before moving to the next level, using a queue. DFS explores as far as possible along each branch before backtracking, using a stack or recursion.",
      twoMarkQuestion: "What data structures are used for BFS and DFS traversal?",
      twoMarkAnswer: "BFS uses a Queue data structure to maintain the order of node exploration (FIFO). DFS uses a Stack (either explicitly or through recursion's call stack) to explore nodes depth-first (LIFO).",
      fiveMarkQuestion: "Compare BFS and DFS in terms of algorithm, space complexity, and applications.",
      fiveMarkAnswer: "BFS vs DFS:\n\n1. BFS Algorithm:\n- Start from source, add to queue\n- While queue is not empty: dequeue a vertex, visit all unvisited neighbors, enqueue them\n- Uses a visited array to avoid cycles\n- Space: O(V) for queue and visited array\n\n2. DFS Algorithm:\n- Start from source, push to stack\n- While stack is not empty: pop a vertex, if not visited mark as visited, push all unvisited neighbors\n- Or use recursion: visit node, recursively visit each unvisited neighbor\n- Space: O(V) for stack/recursion depth\n\n3. Comparison:\n- BFS finds shortest path in unweighted graphs; DFS does not\n- BFS uses more memory (stores entire level); DFS uses less for sparse graphs\n- BFS: O(V+E) time; DFS: O(V+E) time\n\n4. Applications:\n- BFS: Shortest path, level-order traversal, peer-to-peer networks, social networking\n- DFS: Topological sorting, cycle detection, path finding, solving puzzles",
    },
    {
      id: "sc9", nodeId: "s9",
      explanation: "Shortest path algorithms find the minimum cost path between nodes in a graph. Dijkstra's algorithm works for non-negative weights, while Bellman-Ford handles negative weights. Floyd-Warshall finds shortest paths between all pairs of vertices.",
      twoMarkQuestion: "Name two shortest path algorithms and their key difference.",
      twoMarkAnswer: "Dijkstra's algorithm and Bellman-Ford algorithm. Key difference: Dijkstra's works only with non-negative edge weights and is more efficient O(V²) or O(E log V). Bellman-Ford can handle negative edge weights but is slower at O(VE).",
      fiveMarkQuestion: "Explain Dijkstra's shortest path algorithm with an example. What are its limitations?",
      fiveMarkAnswer: "Dijkstra's Algorithm:\n\n1. Initialize distances of all vertices as infinity except source (0)\n2. Create a set of unvisited vertices\n3. For the current vertex, consider all unvisited neighbors\n4. Calculate tentative distance through current vertex\n5. If calculated distance < known distance, update it\n6. Mark current vertex as visited\n7. Select the unvisited vertex with smallest distance as next current vertex\n8. Repeat until all vertices are visited\n\nExample: Graph with vertices A,B,C,D\nEdges: A-B(4), A-C(1), C-B(2), B-D(1), C-D(5)\nStarting from A:\n- Step 1: A=0, B=inf, C=inf, D=inf\n- Step 2: Visit A -> B=4, C=1\n- Step 3: Visit C(smallest) -> B=min(4,1+2)=3, D=6\n- Step 4: Visit B -> D=min(6,3+1)=4\n- Result: A=0, B=3, C=1, D=4\n\nLimitations:\n1. Cannot handle negative edge weights\n2. Not suitable for graphs with negative cycles\n3. Greedy approach may not work with negative weights",
    },
    {
      id: "sc10", nodeId: "s10",
      explanation: "First Come First Served (FCFS) is the simplest CPU scheduling algorithm. Processes are executed in the order they arrive in the ready queue. It is a non-preemptive algorithm, meaning once a process starts executing, it runs to completion.",
      twoMarkQuestion: "What are the disadvantages of FCFS scheduling?",
      twoMarkAnswer: "Disadvantages: (1) Convoy effect - short processes wait behind long processes, (2) High average waiting time, (3) Non-preemptive - a long process blocks all others, (4) Not suitable for time-sharing systems.",
      fiveMarkQuestion: "Explain FCFS scheduling with a numerical example. Calculate average waiting time and turnaround time.",
      fiveMarkAnswer: "FCFS Scheduling:\n\nExample: Three processes with arrival time 0\nP1: Burst time = 24ms\nP2: Burst time = 3ms\nP3: Burst time = 3ms\n\nGantt Chart: |P1|P2|P3|\n             0  24  27  30\n\nWaiting Time:\n- P1 = 0ms (starts immediately)\n- P2 = 24ms (waits for P1)\n- P3 = 27ms (waits for P1 and P2)\n- Average WT = (0+24+27)/3 = 17ms\n\nTurnaround Time:\n- P1 = 24ms\n- P2 = 27ms\n- P3 = 30ms\n- Average TAT = (24+27+30)/3 = 27ms\n\nConvoy Effect:\nIf P2 and P3 arrived first:\nGantt: |P2|P3|P1|\n       0   3   6  30\nAverage WT = (0+3+6)/3 = 3ms\nMuch better! This shows the convoy effect problem.",
    },
    {
      id: "sc11", nodeId: "s11",
      explanation: "Round Robin (RR) scheduling assigns a fixed time quantum to each process. The CPU cycles through all processes in the ready queue, giving each process a time slice. If a process doesn't finish within its quantum, it is preempted and moved to the back of the queue.",
      twoMarkQuestion: "What is a time quantum in Round Robin scheduling?",
      twoMarkAnswer: "A time quantum (or time slice) is a fixed amount of time that each process is allowed to use the CPU in Round Robin scheduling. When the time quantum expires, the process is preempted and placed at the end of the ready queue.",
      fiveMarkQuestion: "Explain Round Robin scheduling. How does the choice of time quantum affect performance?",
      fiveMarkAnswer: "Round Robin Scheduling:\n\nAlgorithm:\n1. Maintain a circular ready queue\n2. Assign a fixed time quantum (q)\n3. Pick the first process from the queue\n4. If burst time <= q, execute to completion\n5. If burst time > q, execute for q time units, preempt, move to end of queue\n6. Repeat until all processes complete\n\nExample: q=4ms\nP1=10ms, P2=4ms, P3=6ms\n\nGantt: |P1|P2|P3|P1|P3|P1|\n       0   4   8  12  16  18  20\n\nEffect of Time Quantum:\n1. Very large q: Degenerates to FCFS, no benefit of RR\n2. Very small q: Too many context switches, overhead increases, throughput decreases\n3. Optimal q: Should be large enough to minimize context switches but small enough for good response time\n4. Rule of thumb: q should be large enough that 80% of CPU bursts are shorter than q\n\nAdvantages:\n- Fair allocation of CPU\n- Good response time\n- No starvation\n\nDisadvantages:\n- Higher average waiting time than SJF\n- Performance depends heavily on time quantum choice",
    },
  ]).onConflictDoNothing();

  console.log("Seeding complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
