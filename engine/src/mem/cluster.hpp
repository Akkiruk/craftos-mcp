/*
 * mem/cluster.hpp
 * CraftOS-PC 2
 * 
 * This file defines the class for the cluster allocator.
 * 
 * This code is licensed under the MIT License.
 * Copyright (c) 2019-2024 JackMacWindows. 
 */

#include <cstddef>

// craftos-agent: 512, not 4096. A cluster is allocated (and zeroed) whole, and every computer has two allocators
// (ropes, substrings) with a cluster each from its first string: 4096 elements was about 400 KB per computer before
// it held a single string. More clusters are chained as needed, and empty ones are freed, as before.
#define CLUSTER_SIZE 512
#define CLUSTER_BITMAP_SIZE CLUSTER_SIZE / (sizeof(bitmap_unit) * 8)

class ClusterAllocator {
    typedef unsigned long bitmap_unit;

    struct cluster_t {
        cluster_t * next;
        unsigned long id;
        bitmap_unit bitmap[CLUSTER_BITMAP_SIZE];
        unsigned char ptr[];
    };

    const size_t elem_size; // size of each element in the cluster
    cluster_t * head; // pointer to first node of cluster list
    cluster_t * freecluster; // pointer to first potentially free cluster

    cluster_t * newcluster(long id);

public:
    ClusterAllocator(const size_t elem_size);
    ~ClusterAllocator();
    void * alloc();
    void free(void * ptr);
};
