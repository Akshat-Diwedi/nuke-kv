#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <iomanip>
#include <fstream>
#include <mutex>
#include <functional>
#include <algorithm>
#include <random>
#include <tuple>
#include <thread>
#include <atomic>
#include <queue>
#include <condition_variable>
#include <future>
#include <list>
#include <cstdio> // For std::remove
#include <locale> // For std::setlocale

#include <nlohmann/json.hpp>

// For system stats & UTF-8 Console
#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#include <unistd.h>
#endif

// --- Type Aliases ---
// FIX: Use ordered_json to preserve key insertion order
using json = nlohmann::ordered_json;
using high_res_clock = std::chrono::high_resolution_clock;

// --- Basic Configuration ---
bool DEBUG_MODE = true;
bool PERSISTENCE_ENABLED = true;
std::string DATABASE_FILENAME = "nukekv.db";

// --- Advanced Configurations ---
bool CACHING_ENABLED = true;
bool PIPELINING_ENABLED = true;
unsigned long long MAX_RAM_GB = 1;
int WORKERS_THREAD_COUNT = 0;
std::atomic<int> BATCH_PROCESSING_SIZE = 1;

// --- Forward Declarations ---
class NukeKV;

// --- Task Structure for Worker Threads ---
struct Task {
    std::string command_str;
    std::vector<std::string> args;
    std::promise<std::string> promise;
};

// --- Utility Functions ---
std::string format_memory_size(unsigned long long bytes) {
    if (bytes == 0) return "0 B";
    const char* suffixes[] = {"B", "KB", "MB", "GB", "TB"};
    int i = 0; double d_bytes = bytes;
    while (d_bytes >= 1024 && i < 4) { d_bytes /= 1024; i++; }
    std::stringstream ss;
    ss << std::fixed << std::setprecision(2) << d_bytes << " " << suffixes[i];
    return ss.str();
}

std::string format_duration(double seconds) {
    std::stringstream ss; ss << std::fixed;
    if (seconds < 0.001) ss << std::setprecision(2) << seconds * 1000000.0 << u8"µs";
    else if (seconds < 1.0) ss << std::setprecision(2) << seconds * 1000.0 << "ms";
    else if (seconds < 60.0) ss << std::setprecision(3) << seconds << "s";
    else if (seconds < 3600.0) {
        ss << static_cast<int>(seconds) / 60 << "m " << std::setprecision(2) << fmod(seconds, 60.0) << "s";
    } else {
        ss << static_cast<int>(seconds) / 3600 << "h " << static_cast<int>(fmod(seconds, 3600.0)) / 60 << "m " << std::setprecision(2) << fmod(seconds, 60.0) << "s";
    }
    return ss.str();
}

json::json_pointer to_json_pointer(const std::string& path) {
    if (path.empty() || path == "$") return json::json_pointer("");
    std::string p = path;
    if (p.rfind("$.", 0) == 0) p = p.substr(2);
    else if (p.rfind("$[", 0) == 0) p = p.substr(1);
    std::replace(p.begin(), p.end(), '.', '/');
    std::string res;
    for (char c : p) { if (c == '[') res += '/'; else if (c != ']') res += c; }
    return json::json_pointer("/" + res);
}

unsigned long long get_current_ram_usage() {
    #ifdef _WIN32
        PROCESS_MEMORY_COUNTERS_EX pmc;
        GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
        return pmc.PrivateUsage;
    #else
        struct rusage usage; getrusage(RUSAGE_SELF, &usage); return usage.ru_maxrss * 1024;
    #endif
}

// --- Core Database Engine ---
class NukeKV {
private:
    std::unordered_map<std::string, std::string> kv_store_;
    std::unordered_map<std::string, long long> ttl_map_;
    std::list<std::string> lru_list_;
    std::unordered_map<std::string, std::list<std::string>::iterator> lru_map_;
    mutable std::mutex data_mutex_;
    std::vector<std::thread> workers_;
    std::queue<Task> task_queue_;
    std::mutex queue_mutex_;
    std::condition_variable condition_;
    std::atomic<bool> stop_all_ = false;
    std::thread background_manager_thread_;
    std::atomic<int> dirty_operations_ = 0;
    std::atomic<unsigned long long> estimated_memory_usage_ = 0;
    unsigned long long max_memory_bytes_ = 0;

    void _update_lru(const std::string& key) {
        if (!CACHING_ENABLED || max_memory_bytes_ == 0) return;
        if (lru_map_.count(key)) lru_list_.erase(lru_map_[key]);
        lru_list_.push_front(key); lru_map_[key] = lru_list_.begin();
    }

    void _enforce_memory_limit() {
        if (!CACHING_ENABLED || max_memory_bytes_ == 0) return;
        while (estimated_memory_usage_ > max_memory_bytes_ && !lru_list_.empty()) {
            std::string key_to_evict = lru_list_.back(); lru_list_.pop_back();
            estimated_memory_usage_ -= (key_to_evict.size() + kv_store_[key_to_evict].size());
            kv_store_.erase(key_to_evict); ttl_map_.erase(key_to_evict); lru_map_.erase(key_to_evict);
            if(DEBUG_MODE) { std::cout << "\n[CACHE] Evicted key '" << key_to_evict << "' to stay within memory limits.\n> " << std::flush; }
        }
    }
    
    void _save_to_file_unlocked(const std::string& filename) {
        if (!PERSISTENCE_ENABLED) return;
        json db_json; db_json["store"] = kv_store_; db_json["ttl"] = ttl_map_;
        std::ofstream db_file(filename);
        if (db_file.is_open()) {
            db_file << db_json.dump(4);
        }
        if (filename == DATABASE_FILENAME) {
            dirty_operations_ = 0;
        }
    }
    
    void _background_manager() {
        while (!stop_all_) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            std::unique_lock<std::mutex> lock(data_mutex_, std::try_to_lock);
            if (!lock.owns_lock()) continue;
            
            auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            std::vector<std::string> expired_keys;
            for (const auto& pair : ttl_map_) {
                if (now_ms > pair.second) expired_keys.push_back(pair.first);
            }
            if (!expired_keys.empty()) {
                for (const auto& key : expired_keys) {
                    if (!kv_store_.count(key)) continue;
                    estimated_memory_usage_ -= (key.size() + kv_store_[key].size());
                    kv_store_.erase(key); ttl_map_.erase(key);
                    if (CACHING_ENABLED && lru_map_.count(key)) { lru_list_.erase(lru_map_[key]); lru_map_.erase(key); }
                    dirty_operations_++;
                }
                if (DEBUG_MODE) std::cout << "\n[BG] Expired " << expired_keys.size() << " key(s).\n> " << std::flush;
            }
            
            int batch_size = BATCH_PROCESSING_SIZE.load();
            if (batch_size > 0 && dirty_operations_ >= batch_size) {
                int ops_to_save = dirty_operations_.load();
                _save_to_file_unlocked(DATABASE_FILENAME);
                if (DEBUG_MODE) {
                    std::cout << "\n[BG] Batch saved " << ops_to_save << " operations to disk.\n> " << std::flush;
                }
            }
        }
    }
    
    void _worker_function();

public:
    NukeKV() {
        if (MAX_RAM_GB > 0) max_memory_bytes_ = MAX_RAM_GB * 1024 * 1024 * 1024;
        int num_threads = (WORKERS_THREAD_COUNT <= 0) ? std::max(1u, std::thread::hardware_concurrency() - 1) : WORKERS_THREAD_COUNT;
        for (int i = 0; i < num_threads; ++i) workers_.emplace_back(&NukeKV::_worker_function, this);
        background_manager_thread_ = std::thread(&NukeKV::_background_manager, this);
    }

    ~NukeKV() {
        stop_all_ = true; condition_.notify_all();
        for (auto& worker : workers_) if (worker.joinable()) worker.join();
        if (background_manager_thread_.joinable()) background_manager_thread_.join();
        if (dirty_operations_ > 0) {
            std::cout << "\nPerforming final save of " << dirty_operations_.load() << " operations..." << std::endl;
            _save_to_file_unlocked(DATABASE_FILENAME);
        }
    }

    void load_from_file();
    std::future<std::string> dispatch_command(const std::string& cmd, const std::vector<std::string>& args);
    
private: 
    std::string _handle_set(const std::vector<std::string>& args);
    std::string _handle_get(const std::vector<std::string>& args);
    std::string _handle_del(const std::vector<std::string>& args);
    std::string _handle_update(const std::vector<std::string>& args);
    std::string _handle_incr_decr(const std::vector<std::string>& args, bool is_incr);
    std::string _handle_ttl(const std::vector<std::string>& args);
    std::string _handle_setttl(const std::vector<std::string>& args);
    std::string _handle_json_set(const std::vector<std::string>& args);
    std::string _handle_json_get(const std::vector<std::string>& args);
    std::string _handle_json_update(const std::vector<std::string>& args);
    std::string _handle_stats();
    std::string _handle_stress(const std::vector<std::string>& args);
    std::string _handle_batch(const std::vector<std::string>& args);
};

void NukeKV::_worker_function() {
    const std::unordered_map<std::string, std::function<std::string(const std::vector<std::string>&)>> command_map = {
        {"SET", [this](const auto&a){return _handle_set(a);}}, {"GET", [this](const auto&a){return _handle_get(a);}},
        {"DEL", [this](const auto&a){return _handle_del(a);}}, {"UPDATE", [this](const auto&a){return _handle_update(a);}},
        {"INCR", [this](const auto&a){return _handle_incr_decr(a,true);}}, {"DECR", [this](const auto&a){return _handle_incr_decr(a,false);}},
        {"TTL", [this](const auto&a){return _handle_ttl(a);}}, {"SETTTL", [this](const auto&a){return _handle_setttl(a);}},
        {"JSON.SET", [this](const auto&a){return _handle_json_set(a);}}, {"JSON.GET", [this](const auto&a){return _handle_json_get(a);}},
        {"JSON.DEL", [this](const auto&a){return _handle_del(a);}}, {"JSON.UPDATE", [this](const auto&a){return _handle_json_update(a);}},
        {"STATS", [this](const auto&a){return _handle_stats();}}, {"STRESS", [this](const auto&a){return _handle_stress(a);}},
        {"BATCH", [this](const auto&a){return _handle_batch(a);}},
    };
    while (!stop_all_) {
        Task task;
        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            condition_.wait(lock, [this]{return !task_queue_.empty() || stop_all_;});
            if (stop_all_ && task_queue_.empty()) return;
            task = std::move(task_queue_.front()); task_queue_.pop();
        }
        try {
            auto it = command_map.find(task.command_str);
            task.promise.set_value(it != command_map.end() ? it->second(task.args) : "-ERR unknown command '" + task.command_str + "'");
        } catch (...) { task.promise.set_value("-ERR unknown worker exception"); }
    }
}

std::future<std::string> NukeKV::dispatch_command(const std::string& cmd, const std::vector<std::string>& args) {
    Task task; task.command_str = cmd; task.args = args;
    auto future = task.promise.get_future();
    { std::lock_guard<std::mutex> lock(queue_mutex_); task_queue_.push(std::move(task)); }
    condition_.notify_one(); return future;
}

void NukeKV::load_from_file() {
    if (!PERSISTENCE_ENABLED) return;
    std::ifstream ifs(DATABASE_FILENAME);
    if (!ifs.is_open()) {
        std::cout << "[INFO] Database file not found. Creating a new one." << std::endl;
        std::ofstream new_db_file(DATABASE_FILENAME);
        new_db_file.close(); return;
    }
    std::unique_lock<std::mutex> lock(data_mutex_);
    json db_json;
    try { ifs >> db_json; } catch (...) { std::cerr << "[ERROR] Could not parse database file." << std::endl; return; }
    if (db_json.count("store")) kv_store_ = db_json["store"].get<std::unordered_map<std::string, std::string>>();
    if (db_json.count("ttl")) ttl_map_ = db_json["ttl"].get<std::unordered_map<std::string, long long>>();
    for(const auto& pair : kv_store_){
        estimated_memory_usage_ += (pair.first.size() + pair.second.size());
        _update_lru(pair.first);
    }
    _enforce_memory_limit();
    std::cout << "[INFO] Loaded " << kv_store_.size() << " keys into memory." << std::endl;
}

// --- Command Handlers ---

std::string NukeKV::_handle_set(const std::vector<std::string>& args) {
    if (args.size() != 2 && args.size() != 4) return "-ERR wrong number of arguments";
    std::unique_lock<std::mutex> lock(data_mutex_);
    const auto& key = args[0]; const std::string& value = args[1];
    unsigned long long old_size = kv_store_.count(key) ? key.size() + kv_store_[key].size() : 0;
    kv_store_[key] = value;
    estimated_memory_usage_ += (key.size() + value.size()) - old_size;
    _update_lru(key);
    if (args.size() == 4 && (args[2] == "EX" || args[2] == "ex")) {
        try { ttl_map_[key] = std::chrono::duration_cast<std::chrono::milliseconds>((std::chrono::system_clock::now() + std::chrono::seconds(std::stoll(args[3]))).time_since_epoch()).count(); } 
        catch (...) { return "-ERR value is not an integer"; }
    } else { ttl_map_.erase(key); }
    dirty_operations_++; _enforce_memory_limit();
    if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME);
    return "+OK";
}

std::string NukeKV::_handle_update(const std::vector<std::string>& args) {
    if (args.size() != 2) return "-ERR wrong number of arguments";
    std::unique_lock<std::mutex> lock(data_mutex_);
    if (!kv_store_.count(args[0])) return "-ERR key does not exist";
    const auto& key = args[0]; const std::string& value = args[1];
    unsigned long long old_size = key.size() + kv_store_.at(key).size();
    kv_store_[key] = value;
    estimated_memory_usage_ += (key.size() + value.size()) - old_size;
    _update_lru(key);
    dirty_operations_++; _enforce_memory_limit();
    if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME);
    return "+OK";
}

std::string NukeKV::_handle_incr_decr(const std::vector<std::string>& args, bool is_incr) {
    if (args.empty() || args.size() > 2) return "-ERR wrong number of arguments";
    std::unique_lock<std::mutex> lock(data_mutex_);
    const auto& key = args[0];
    long long amount = 1;
    if (args.size() == 2) { try { amount = std::stoll(args[1]); } catch (...) { return "-ERR not an integer"; } }
    if (!is_incr) amount = -amount;
    long long current_val = 0;
    unsigned long long old_size = 0;
    if (kv_store_.count(key)) {
        try { current_val = std::stoll(kv_store_.at(key)); old_size = key.size() + kv_store_.at(key).size(); }
        catch (...) { return "-ERR value is not an integer"; }
    }
    std::string new_val_str = std::to_string(current_val + amount);
    kv_store_[key] = new_val_str;
    estimated_memory_usage_ += (key.size() + new_val_str.size()) - old_size;
    _update_lru(key);
    dirty_operations_++; _enforce_memory_limit();
    if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME);
    return ":" + new_val_str;
}

std::string NukeKV::_handle_json_set(const std::vector<std::string>& args) {
    if (args.size() != 2 && args.size() != 4) return "-ERR wrong number of arguments for 'JSON.SET'";
    json j;
    try { j = json::parse(args[1]); } catch (const json::parse_error& e) { return std::string("-ERR invalid JSON: ") + e.what(); }
    std::vector<std::string> set_args = {args[0], j.dump()};
    if (args.size() == 4) { set_args.push_back(args[2]); set_args.push_back(args[3]); }
    return _handle_set(set_args);
}

std::string NukeKV::_handle_json_update(const std::vector<std::string>& args) {
    if (args.size() < 3 || (args.size() - 1) % 2 != 0) return "-ERR wrong argument format";
    std::unique_lock<std::mutex> lock(data_mutex_);
    if (!kv_store_.count(args[0])) return "-ERR key does not exist";
    try {
        std::string value_str = kv_store_.at(args[0]);
        unsigned long long old_size = args[0].size() + value_str.size();
        json j = json::parse(value_str);
        if (!j.is_object()) return "-ERR not a JSON object";
        for (size_t i = 1; i < args.size(); i += 2) {
            try { j[args[i]] = json::parse(args[i+1]); } catch (...) { j[args[i]] = args[i+1]; }
        }
        std::string new_dump = j.dump();
        kv_store_[args[0]] = new_dump;
        estimated_memory_usage_ += (args[0].size() + kv_store_.at(args[0]).size()) - old_size;
        _update_lru(args[0]); dirty_operations_++; _enforce_memory_limit();
        if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME);
    } catch (...) { return "-ERR not a valid JSON object"; }
    return "+OK";
}

std::string NukeKV::_handle_stress(const std::vector<std::string>& args) {
    if (args.size() != 1) return "-ERR STRESS requires exactly one argument (e.g., STRESS 1000)";
    int count;
    try { count = std::stoi(args[0]); } catch (...) { return "-ERR invalid number for count"; }
    if (count <= 0) return "-ERR count must be positive";

    const std::string STRESS_DB_FILENAME = "stress-test.db";
    std::remove(STRESS_DB_FILENAME.c_str()); 
    auto overall_start = high_res_clock::now();
    unsigned long long max_ram_usage = 0;
    std::vector<std::string> keys(count);
    for(int i = 0; i < count; ++i) keys[i] = "stress:" + std::to_string(i);

    auto run_benchmark = [&](std::function<void(int)> op) {
        auto start = high_res_clock::now();
        for (int i = 0; i < count; ++i) op(i);
        max_ram_usage = std::max(max_ram_usage, get_current_ram_usage());
        return std::chrono::duration<double>(high_res_clock::now() - start).count();
    };

    std::stringstream ss;
    ss << "\nStress Test running for " << count << " ops...\n" << "-------------------------------------------";
    
    double set_dur = run_benchmark([&](int i){ _handle_set({keys[i], "svalue"}); });
    ss << "\n" << std::left << std::setw(8) << "SET:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count / set_dur) << " ops/sec (" << format_duration(set_dur) << " total)";
    double update_dur = run_benchmark([&](int i){ _handle_update({keys[i], "nvalue"}); });
    ss << "\n" << std::left << std::setw(8) << "UPDATE:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count / update_dur) << " ops/sec (" << format_duration(update_dur) << " total)";
    double get_dur = run_benchmark([&](int i){ _handle_get({keys[i]}); });
    ss << "\n" << std::left << std::setw(8) << "GET:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count / get_dur) << " ops/sec (" << format_duration(get_dur) << " total)";
    double del_dur = run_benchmark([&](int i){ _handle_del({keys[i]}); });
    ss << "\n" << std::left << std::setw(8) << "DEL:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count / del_dur) << " ops/sec (" << format_duration(del_dur) << " total)";
    
    double total_time = std::chrono::duration<double>(high_res_clock::now() - overall_start).count();
    ss << "\n-------------------------------------------"
       << "\nMAX RAM USAGE: " << format_memory_size(max_ram_usage)
       << "\n-------------------------------------------"
       << "\nTotal Stress Test Time: " << format_duration(total_time);
    _save_to_file_unlocked(STRESS_DB_FILENAME);
    std::remove(STRESS_DB_FILENAME.c_str());
    return ss.str();
}

// --- Other handlers (unchanged logic) ---
std::string NukeKV::_handle_get(const std::vector<std::string>& args) { if (args.size() != 1) return "-ERR wrong number of arguments"; std::unique_lock<std::mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return "(nil)"; _update_lru(args[0]); return kv_store_.at(args[0]); }
std::string NukeKV::_handle_del(const std::vector<std::string>& args) { if (args.empty()) return "-ERR wrong number of arguments"; std::unique_lock<std::mutex> lock(data_mutex_); int deleted_count = 0; for (const auto& key : args) { if (kv_store_.count(key)) { estimated_memory_usage_ -= (key.size() + kv_store_.at(key).size()); kv_store_.erase(key); ttl_map_.erase(key); if (CACHING_ENABLED && lru_map_.count(key)) { lru_list_.erase(lru_map_[key]); lru_map_.erase(key); } deleted_count++; } } if (deleted_count > 0) { dirty_operations_ += deleted_count; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); } return ":" + std::to_string(deleted_count); }
std::string NukeKV::_handle_batch(const std::vector<std::string>& args) { if (args.size() != 1) return "-ERR BATCH requires one argument (e.g., BATCH 100)"; int new_size; try { new_size = std::stoi(args[0]); } catch(...) { return "-ERR value is not an integer"; } if (new_size < 0) return "-ERR batch size cannot be negative"; BATCH_PROCESSING_SIZE.store(new_size); return "+OK"; }
std::string NukeKV::_handle_ttl(const std::vector<std::string>& args) { if (args.size() != 1) return "-ERR wrong number of arguments"; std::unique_lock<std::mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return ":-2"; if (!ttl_map_.count(args[0])) return ":-1"; auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); if (now_ms > ttl_map_.at(args[0])) return ":-2"; return ":" + std::to_string((ttl_map_.at(args[0]) - now_ms) / 1000); }
std::string NukeKV::_handle_setttl(const std::vector<std::string>& args) { if (args.size() != 2) return "-ERR wrong number of arguments"; std::unique_lock<std::mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return "-ERR key does not exist"; try { long long ttl_s = std::stoll(args[1]); if (ttl_s <= 0) ttl_map_.erase(args[0]); else ttl_map_[args[0]] = std::chrono::duration_cast<std::chrono::milliseconds>((std::chrono::system_clock::now() + std::chrono::seconds(ttl_s)).time_since_epoch()).count(); } catch (...) { return "-ERR invalid TTL value"; } dirty_operations_++; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return "+OK"; }
std::string NukeKV::_handle_json_get(const std::vector<std::string>& args) { if (args.empty()) return "-ERR wrong number of arguments"; std::unique_lock<std::mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return "(nil)"; _update_lru(args[0]); json doc; try { doc = json::parse(kv_store_.at(args[0])); } catch (...) { return "-ERR not a valid JSON document"; } if (args.size() == 1) return doc.dump(2); json result = json::object(); for (size_t i = 1; i < args.size(); ++i) { try { result[args[i]] = doc.at(to_json_pointer(args[i])); } catch (...) { result[args[i]] = nullptr; } } return result.dump(2); }
std::string NukeKV::_handle_stats() { std::unique_lock<std::mutex> lock(data_mutex_); int num_threads = (WORKERS_THREAD_COUNT <= 0) ? std::max(1u, std::thread::hardware_concurrency() - 1) : WORKERS_THREAD_COUNT; std::stringstream ss; ss << "Version: NukeKV High-Performance\n"; ss << "Worker Threads: " << num_threads << "\n"; ss << "Persistence: " << (PERSISTENCE_ENABLED ? "Enabled" : "Disabled") << "\n"; if (PERSISTENCE_ENABLED) ss << "  - Batch Size: " << BATCH_PROCESSING_SIZE.load() << "\n  - Unsaved Ops: " << dirty_operations_.load() << "\n"; ss << "Caching: " << (CACHING_ENABLED ? "Enabled" : "Disabled") << "\n"; if (CACHING_ENABLED) ss << "  - Memory Limit: " << (max_memory_bytes_ > 0 ? format_memory_size(max_memory_bytes_) : "Unlimited") << "\n  - Memory Used: " << format_memory_size(estimated_memory_usage_.load()) << "\n"; ss << "Total Keys: " << kv_store_.size() << "\n"; ss << "Keys with TTL: " << ttl_map_.size(); return ss.str(); }

// --- Command Line Parser ---
std::vector<std::string> parse_command_line(const std::string& line) {
    std::vector<std::string> args; std::string current_arg; char quote_type = 0;
    for (char c : line) {
        if (quote_type == 0 && (c == '\'' || c == '"')) { if (!current_arg.empty()) { args.push_back(current_arg); current_arg.clear(); } quote_type = c;
        } else if (c == quote_type) { args.push_back(current_arg); current_arg.clear(); quote_type = 0;
        } else if (quote_type == 0 && isspace(c)) { if (!current_arg.empty()) { args.push_back(current_arg); current_arg.clear(); }
        } else { current_arg += c; }
    }
    if (!current_arg.empty()) args.push_back(current_arg);
    args.erase(std::remove(args.begin(), args.end(), "&"), args.end());
    return args;
}

// --- Main Application Loop ---
int main() {
    #ifdef _WIN32
        SetConsoleOutputCP(CP_UTF8);
        SetConsoleCP(CP_UTF8);
    #else
        std::setlocale(LC_ALL, "en_US.UTF-8");
    #endif

    NukeKV db; db.load_from_file();
    int num_threads = (WORKERS_THREAD_COUNT <= 0) ? std::max(1u, std::thread::hardware_concurrency() - 1) : WORKERS_THREAD_COUNT;
    std::cout << "NukeKV High-Performance Engine Started. (UTF-8 Enabled ✨)" << std::endl;
    std::cout << "Workers: " << num_threads << ", Batching: " << BATCH_PROCESSING_SIZE.load() << ", Type HELP for commands." << std::endl;

    std::string line; bool in_pipeline = false;
    std::vector<std::future<std::string>> pipeline_futures;
    const std::string HELP_MESSAGE = R"raw(
NukeKV Command Reference:

STRING COMMANDS:
  SET key "value" [EX seconds] - Sets a key to a string value (UTF-8 OK), with optional expiry.
  GET key                      - Retrieves the value of a key.
  UPDATE key "new_value"         - Updates an existing key's value. Fails if key doesn't exist.
  DEL key [key2 ...]           - Deletes one or more keys.
  INCR key [amount]            - Increments a numeric key by 1 or by a given amount.
  DECR key [amount]            - Decrements a numeric key by 1 or by a given amount.

JSON COMMANDS:
  JSON.SET key '{"a":1}' [EX s] - Sets a key to a JSON object (key order is preserved).
  JSON.GET key [path]          - Retrieves the whole JSON or a value at a specific path (e.g., $.a).
  JSON.UPDATE key field "val"    - Updates a field within a JSON object (key order is preserved).
  JSON.DEL key                 - Deletes a JSON key (same as DEL).

LIFECYCLE & TTL:
  TTL key                      - Returns the remaining time-to-live of a key in seconds.
  SETTTL key seconds           - Sets or updates the time-to-live for an existing key.

SERVER & DIAGNOSTICS:
  PING                         - Returns "PONG", useful for checking connection.
  STATS                        - Shows server statistics and configuration.
  BATCH <size>                 - Sets the write-batching size (e.g., BATCH 100). 0 means immediate writes.
  STRESS <count>               - Runs a full benchmark suite (SET, UPDATE, GET, DEL).
  HELP                         - Shows this help message.
  CLS                          - Clears the screen.
  QUIT                         - Exits the server.

PIPELINING:
  PIPE_BEGIN                   - Starts a command pipeline.
  PIPE_END                     - Executes all commands in the pipeline.

)raw";

    while (true) {
        std::cout << (in_pipeline ? "PIPE> " : "> ");
        if (!std::getline(std::cin, line)) break;
        if (line.empty()) continue;
        auto args_str = parse_command_line(line);
        if (args_str.empty()) continue;
        std::string command_str = args_str[0];
        std::transform(command_str.begin(), command_str.end(), command_str.begin(), ::toupper);
        args_str.erase(args_str.begin());
        
        if (PIPELINING_ENABLED && command_str == "PIPE_BEGIN") { if (in_pipeline) { std::cout << "-ERR already in a pipeline block" << std::endl; continue; } in_pipeline = true; pipeline_futures.clear(); std::cout << "+OK Begin pipeline. End with PIPE_END." << std::endl; continue; }
        if (PIPELINING_ENABLED && command_str == "PIPE_END") { if (!in_pipeline) { std::cout << "-ERR not in a pipeline block" << std::endl; continue; } auto pipe_start = high_res_clock::now(); for (size_t i = 0; i < pipeline_futures.size(); ++i) std::cout << i + 1 << ") " << pipeline_futures[i].get() << std::endl; auto pipe_duration_s = std::chrono::duration<double>(high_res_clock::now() - pipe_start).count(); std::cout << "--- Pipeline completed in " << format_duration(pipe_duration_s) << " ---" << std::endl; in_pipeline = false; continue; }

        auto start_time = high_res_clock::now(); std::string result;
        if (command_str == "QUIT") break;
        else if (command_str == "PING") result = "+PONG";
        else if (command_str == "HELP") result = HELP_MESSAGE;
        else if (command_str == "CLS") { system("clear || cls"); continue; }
        else {
             auto future = db.dispatch_command(command_str, args_str);
             if (in_pipeline) { pipeline_futures.push_back(std::move(future)); std::cout << "+QUEUED" << std::endl; } 
             else { result = future.get(); }
        }

        if (!in_pipeline) {
            std::cout << result;
            if (DEBUG_MODE && command_str != "STRESS") {
                auto duration_s = std::chrono::duration<double>(high_res_clock::now() - start_time).count();
                std::cout << " (" << format_duration(duration_s) << ")";
            }
            std::cout << std::endl;
        }
    }
    std::cout << "\nShutting down..." << std::endl; return 0;
}

// code to build the exe !
// g++ -std=c++17 main.cpp -I. -o nukekv.exe