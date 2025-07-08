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
#include <shared_mutex>
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
#include <cstdio>
#include <locale>
#include <memory>
#include <cctype>
#include <new>

// --- Platform-Specific Includes ---
#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #include <windows.h>
    #include <psapi.h>
    #pragma comment(lib, "ws2_32.lib")
    #pragma comment(lib, "psapi.lib")
    using socket_t = SOCKET;
    const socket_t INVALID_SOCKET_VAL = INVALID_SOCKET;
    #define close_socket(s) closesocket(s)
#else
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <unistd.h>
    #include <sys/resource.h>
    #include <netinet/tcp.h>
    #include <sys/param.h> 
    #include <sys/stat.h>
    using socket_t = int;
    const socket_t INVALID_SOCKET_VAL = -1;
    #define close_socket(s) close(s)
#endif

#include "libs/json.hpp"
#include "libs/httplib.h"

// --- Cross-Platform Endian Conversion ---
#if defined(__GNUC__) || defined(__clang__)
    #define NUKE_BSWAP_64(x) __builtin_bswap64(x)
#elif defined(_MSC_VER)
    #include <stdlib.h>
    #define NUKE_BSWAP_64(x) _byteswap_uint64(x)
#else
    inline uint64_t NUKE_BSWAP_64(uint64_t val) { val = ((val << 8) & 0xFF00FF00FF00FF00ULL ) | ((val >> 8) & 0x00FF00FF00FF00ULL ); val = ((val << 16) & 0xFFFF0000FFFF0000ULL) | ((val >> 16) & 0x0000FFFF0000FFFFULL); return (val << 32) | (val >> 32); }
#endif
#if (defined(__BYTE_ORDER) && __BYTE_ORDER == __LITTLE_ENDIAN) || (defined(BYTE_ORDER) && BYTE_ORDER == LITTLE_ENDIAN) || defined(_WIN32)
    inline uint64_t nuke_htonll(uint64_t val) { return NUKE_BSWAP_64(val); }
    inline uint64_t nuke_ntohll(uint64_t val) { return NUKE_BSWAP_64(val); }
#else
    inline uint64_t nuke_htonll(uint64_t val) { return val; }
    inline uint64_t nuke_ntohll(uint64_t val) { return val; }
#endif

// --- Type Aliases ---
using json = nlohmann::ordered_json;
using high_res_clock = std::chrono::high_resolution_clock;
using HandlerResult = std::pair<int, std::string>;

// --- Basic Configuration ---
const unsigned short SERVER_PORT = 8080;
// CRITICAL: This security and stability feature prevents memory exhaustion from malicious scanners or malformed requests.
const uint64_t MAX_PAYLOAD_SIZE = 1 * 1024 * 1024 * 1024; // 1 GB sanity limit
std::atomic<bool> DEBUG_MODE(false); // Set to 'false' by default for clean production logs
bool PERSISTENCE_ENABLED = true;
std::string DATABASE_FILENAME = "nukekv.db";

// --- Advanced Configurations ---
bool CACHING_ENABLED = true;
unsigned long long MAX_RAM_GB = 0;
int WORKERS_THREAD_COUNT = 0;
std::atomic<int> BATCH_PROCESSING_SIZE = 1;

// --- Utility Functions ---
inline std::string format_memory_size(unsigned long long bytes) { if (bytes == 0) return "0 B"; const char* suffixes[] = {"B", "KB", "MB", "GB", "TB", "PB"}; int i = 0; double d_bytes = bytes; while (d_bytes >= 1024 && i < 5) { d_bytes /= 1024; i++; } std::stringstream ss; ss << std::fixed << std::setprecision(2) << d_bytes << " " << suffixes[i]; return ss.str(); }
inline std::string format_duration(double seconds) { std::stringstream ss; ss << std::fixed; if (seconds < 0.001) ss << std::setprecision(2) << seconds * 1000000.0 << u8"µs"; else if (seconds < 1.0) ss << std::setprecision(2) << seconds * 1000.0 << "ms"; else if (seconds < 60.0) ss << std::setprecision(3) << seconds << "s"; else if (seconds < 3600.0) { ss << static_cast<int>(seconds) / 60 << "m " << std::setprecision(2) << fmod(seconds, 60.0) << "s"; } else { ss << static_cast<int>(seconds) / 3600 << "h " << static_cast<int>(fmod(seconds, 3600.0)) / 60 << "m " << std::setprecision(2) << fmod(seconds, 60.0) << "s"; } return ss.str(); }
inline json::json_pointer to_json_pointer(const std::string& path) { if (path.empty() || path == "$") return json::json_pointer(""); std::string p = path; if (p.rfind("$.", 0) == 0) p = p.substr(2); else if (p.rfind("$[", 0) == 0) p = p.substr(1); std::replace(p.begin(), p.end(), '.', '/'); std::string res; for (char c : p) { if (c == '[') res += '/'; else if (c != ']') res += c; } return json::json_pointer("/" + res); }

inline unsigned long long get_current_ram_usage() {
    #if defined(_WIN32)
        PROCESS_MEMORY_COUNTERS_EX pmc;
        return GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc)) ? pmc.PrivateUsage : 0;
    #else
        struct rusage usage;
        return getrusage(RUSAGE_SELF, &usage) == 0 ? (
    #if defined(__APPLE__) && defined(__MACH__)
        usage.ru_maxrss
    #else
        usage.ru_maxrss * 1024
    #endif
        ) : 0;
    #endif
}

inline long long get_file_size(const std::string& filename) {
    #ifdef _WIN32
        HANDLE hFile = CreateFileA(filename.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hFile == INVALID_HANDLE_VALUE) return -1;
        LARGE_INTEGER size;
        if (!GetFileSizeEx(hFile, &size)) { CloseHandle(hFile); return -1; }
        CloseHandle(hFile);
        return size.QuadPart;
    #else
        struct stat stat_buf;
        int rc = stat(filename.c_str(), &stat_buf);
        return rc == 0 ? stat_buf.st_size : -1;
    #endif
}

inline std::string get_public_ip() {
    const std::vector<const char*> ip_services = {"api.ipify.org", "icanhazip.com", "ifconfig.me"};
    for (const char* host : ip_services) {
        try {
            httplib::Client cli(host);
            cli.set_connection_timeout(2, 0);
            auto res = cli.Get("/");
            if (res && res->status == 200 && !res->body.empty() && res->body.find('.') != std::string::npos) {
                res->body.erase(res->body.find_last_not_of(" \n\r\t")+1);
                if (!res->body.empty()) return res->body;
            }
        } catch (...) { /* Continue to next service on failure */ }
    }
    return ""; 
}

// ** NEW: Helper function for advanced word search **
inline bool is_word_delimiter(unsigned char c) {
    // A delimiter is anything NOT a letter or a number.
    // This is faster than std::isalnum and not locale-dependent.
    return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'));
}

// ** NEW: Advanced word-based, case-insensitive recursive JSON search **
inline bool json_contains_word(const json& j, const std::string& term) {
    // Predicate for case-insensitive comparison, defined once as a static local for efficiency
    static const auto case_insensitive_equals = [](unsigned char c1, unsigned char c2) {
        return std::tolower(c1) == std::tolower(c2);
    };

    if (j.is_string()) {
        const std::string& text = j.get<std::string>();
        if (term.length() > text.length()) return false;

        auto it = text.begin();
        while (it != text.end()) {
            // Use std::search with the custom predicate to find a potential match
            it = std::search(it, text.end(), term.begin(), term.end(), case_insensitive_equals);

            if (it == text.end()) {
                break; // No more potential matches in the rest of the string
            }

            // A potential match was found, now verify it's a whole word by checking boundaries
            size_t pos = std::distance(text.begin(), it);
            bool left_boundary_ok = (pos == 0) || is_word_delimiter(text[pos - 1]);
            bool right_boundary_ok = (pos + term.length() == text.length()) || is_word_delimiter(text[pos + term.length()]);

            if (left_boundary_ok && right_boundary_ok) {
                return true; // Confirmed whole word match
            }
            
            // Not a whole word, so advance iterator to continue searching after this spot
            ++it;
        }
        return false; // No whole word match found in this string
    } else if (j.is_object()) {
        for (const auto& el : j.items()) {
            if (json_contains_word(el.value(), term)) return true;
        }
    } else if (j.is_array()) {
        for (const auto& el : j) {
            if (json_contains_word(el, term)) return true;
        }
    }
    return false;
}

class NukeKV;
struct Task { std::string command_str; std::vector<std::string> args; std::promise<HandlerResult> promise; };

// --- Core Database Engine ---
class NukeKV {
private:
    std::unordered_map<std::string, std::string> kv_store_;
    std::unordered_map<std::string, long long> ttl_map_;
    std::list<std::string> lru_list_;
    std::unordered_map<std::string, std::list<std::string>::iterator> lru_map_;
    
    mutable std::shared_mutex data_mutex_;
    std::vector<std::thread> workers_;
    std::queue<Task> task_queue_;
    std::mutex queue_mutex_;
    std::condition_variable condition_;
    std::atomic<bool> stop_all_ = false;
    std::thread background_manager_thread_;
    std::atomic<int> dirty_operations_ = 0;
    std::atomic<unsigned long long> estimated_memory_usage_ = 0;
    unsigned long long max_memory_bytes_ = 0;
    
    void _update_lru(const std::string& key) { if (!CACHING_ENABLED || max_memory_bytes_ == 0) return; if (lru_map_.count(key)) lru_list_.erase(lru_map_[key]); lru_list_.push_front(key); lru_map_[key] = lru_list_.begin(); }
    void _enforce_memory_limit() { if (!CACHING_ENABLED || max_memory_bytes_ == 0) return; while (estimated_memory_usage_ > max_memory_bytes_ && !lru_list_.empty()) { std::string key_to_evict = lru_list_.back(); lru_list_.pop_back(); kv_store_.erase(key_to_evict); ttl_map_.erase(key_to_evict); lru_map_.erase(key_to_evict); if(DEBUG_MODE.load()) { std::cout << "\n[CACHE] Evicted key '" << key_to_evict << "' to stay within memory limits." << std::endl; } } }
    void _save_to_file_unlocked(const std::string& filename) { if (!PERSISTENCE_ENABLED) return; json db_json; db_json["store"] = kv_store_; db_json["ttl"] = ttl_map_; std::ofstream db_file(filename); if (db_file.is_open()) db_file << db_json.dump(4); if (filename == DATABASE_FILENAME) dirty_operations_ = 0; }
    void _worker_function();
    void _background_manager() { while (!stop_all_) { std::this_thread::sleep_for(std::chrono::seconds(1)); std::unique_lock<std::shared_mutex> lock(data_mutex_, std::try_to_lock); if (!lock.owns_lock()) continue; auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); std::vector<std::string> expired_keys; for (const auto& pair : ttl_map_) if (now_ms > pair.second) expired_keys.push_back(pair.first); if (!expired_keys.empty()) { for (const auto& key : expired_keys) { if (!kv_store_.count(key)) continue; estimated_memory_usage_ -= (key.size() + kv_store_.at(key).size()); kv_store_.erase(key); ttl_map_.erase(key); if (CACHING_ENABLED && lru_map_.count(key)) { lru_list_.erase(lru_map_[key]); lru_map_.erase(key); } dirty_operations_++; } if (DEBUG_MODE.load()) std::cout << "\n[BG] Expired " << expired_keys.size() << " key(s)." << std::endl; } int batch_size = BATCH_PROCESSING_SIZE.load(); if (batch_size > 0 && dirty_operations_ >= batch_size) { int ops = dirty_operations_.load(); _save_to_file_unlocked(DATABASE_FILENAME); if (DEBUG_MODE.load()) std::cout << "\n[BG] Batch saved " << ops << " operations to disk." << std::endl; } } }
    HandlerResult _handle_set(const std::vector<std::string>& args, bool mark_dirty = true) { if (args.size() != 2 && args.size() != 4) return {400, "-ERR wrong number of arguments for 'SET'. Expected: SET <key> \"<value>\" [EX <seconds>]"}; std::unique_lock<std::shared_mutex> lock(data_mutex_); const auto& key = args[0]; const std::string& value = args[1]; unsigned long long old_size = kv_store_.count(key) ? key.size() + kv_store_[key].size() : 0; kv_store_[key] = value; estimated_memory_usage_ += (key.size() + value.size()) - old_size; _update_lru(key); if (args.size() == 4) { std::string mode = args[2]; std::transform(mode.begin(), mode.end(), mode.begin(), ::toupper); if (mode == "EX") { try { ttl_map_[key] = std::chrono::duration_cast<std::chrono::milliseconds>((std::chrono::system_clock::now() + std::chrono::seconds(std::stoll(args[3]))).time_since_epoch()).count(); } catch (...) { return {400, "-ERR value is not an integer"}; } } } else { ttl_map_.erase(key); } if (mark_dirty) { dirty_operations_++; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); } _enforce_memory_limit(); return {200, "+OK"}; }
    HandlerResult _handle_get(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR wrong number of arguments"}; const auto& key = args[0]; std::string result_value; { std::shared_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; result_value = kv_store_.at(key); } { std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; _update_lru(key); } return {200, result_value}; }
    HandlerResult _handle_update(const std::vector<std::string>& args) { if (args.size() != 2) return {400, "-ERR wrong number of arguments for 'UPDATE'. Expected: UPDATE <key> \"<value>\""}; std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return {404, "(nil)"}; const auto& key = args[0]; const std::string& value = args[1]; unsigned long long old_size = key.size() + kv_store_.at(key).size(); kv_store_[key] = value; estimated_memory_usage_ += (key.size() + value.size()) - old_size; _update_lru(key); dirty_operations_++; _enforce_memory_limit(); if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, "+OK"}; }
    HandlerResult _handle_del(const std::vector<std::string>& args, bool mark_dirty = true) { if (args.empty()) return {400, "-ERR wrong number of arguments"}; std::unique_lock<std::shared_mutex> lock(data_mutex_); int deleted_count = 0; for (const auto& key : args) { if (kv_store_.count(key)) { estimated_memory_usage_ -= (key.size() + kv_store_.at(key).size()); kv_store_.erase(key); ttl_map_.erase(key); if (CACHING_ENABLED && lru_map_.count(key)) { lru_list_.erase(lru_map_[key]); lru_map_.erase(key); } deleted_count++; } } if (deleted_count == 0) return {200, "0"}; if (mark_dirty) { dirty_operations_ += deleted_count; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); } return {200, std::to_string(deleted_count)}; }
    HandlerResult _handle_incr_decr(const std::vector<std::string>& args, bool is_incr) { if (args.empty() || args.size() > 2) return {400, "-ERR wrong number of arguments"}; std::unique_lock<std::shared_mutex> lock(data_mutex_); const auto& key = args[0]; long long amount = 1; if (args.size() == 2) { try { amount = std::stoll(args[1]); } catch (...) { return {400, "-ERR not an integer"}; } } if (!is_incr) amount = -amount; long long current_val = 0; unsigned long long old_size = 0; if (kv_store_.count(key)) { try { current_val = std::stoll(kv_store_.at(key)); old_size = key.size() + kv_store_.at(key).size(); } catch (...) { return {400, "-ERR value is not an integer"}; } } std::string new_val_str = std::to_string(current_val + amount); kv_store_[key] = new_val_str; estimated_memory_usage_ += (key.size() + new_val_str.size()) - old_size; _update_lru(key); dirty_operations_++; _enforce_memory_limit(); if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, new_val_str}; }
    HandlerResult _handle_json_set(const std::vector<std::string>& args) { if (args.size() != 2 && args.size() != 4) return {400, "-ERR wrong number of arguments for 'JSON.SET'. Expected: JSON.SET <key> '<value>' [EX <seconds>]"}; json j; try { j = json::parse(args[1]); } catch (const json::parse_error& e) { return {400, std::string("-ERR invalid JSON: ") + e.what()}; } std::vector<std::string> set_args = {args[0], j.dump()}; if (args.size() == 4) { set_args.push_back(args[2]); set_args.push_back(args[3]); } return _handle_set(set_args); }
    HandlerResult _handle_json_get(const std::vector<std::string>& args) { if (args.empty()) return {400, "-ERR wrong number of arguments"}; const auto& key = args[0]; std::string result_dump; { std::shared_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; json doc; try { doc = json::parse(kv_store_.at(key)); } catch (...) { return {500, "-ERR not a valid JSON document"}; } auto where_it = std::find(args.begin(), args.end(), "WHERE"); if (where_it != args.end()) { if (std::distance(where_it, args.end()) != 3) return {400, "-ERR syntax: ... WHERE <field> <value>"}; if (!doc.is_array()) return {400, "-ERR `WHERE` clause can only be used on JSON arrays."}; const auto& field = *(where_it + 1); json value_to_find; try { value_to_find = json::parse(*(where_it + 2)); } catch(...) { value_to_find = *(where_it + 2); } json results = json::array(); for (const auto& item : doc) { if (item.is_object() && item.contains(field) && item[field] == value_to_find) { results.push_back(item); } } if (results.empty()) return {404, "[]"}; result_dump = results.dump(2); } else if (args.size() > 1) { json result = json::object(); for (size_t i = 1; i < args.size(); ++i) { std::string path_key = args[i]; std::string clean_key = path_key; if (clean_key.rfind("$.", 0) == 0) clean_key = clean_key.substr(2); else if (clean_key.rfind("$[", 0) == 0) clean_key = clean_key.substr(1); try { result[clean_key] = doc.at(to_json_pointer(path_key)); } catch (...) { result[clean_key] = nullptr; } } result_dump = result.dump(2); } else { result_dump = doc.dump(2); } } { std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; _update_lru(key); } return {200, result_dump}; }
    HandlerResult _handle_json_update(const std::vector<std::string>& args) { if (args.size() < 4) return {400, "-ERR invalid syntax for JSON.UPDATE"}; auto where_it = std::find(args.begin(), args.end(), "WHERE"); auto set_it = std::find(args.begin(), args.end(), "SET"); if (where_it == args.end() || set_it == args.end() || std::distance(where_it, set_it) != 3) return {400, "-ERR syntax error. Expected: ... WHERE <field> <value> SET ..."}; const std::string& key = args[0]; const std::string& where_field = *(where_it + 1); json where_value; try { where_value = json::parse(*(where_it + 2)); } catch(...) { where_value = *(where_it + 2); } if (std::distance(set_it, args.end()) < 3 || (std::distance(set_it, args.end()) - 1) % 2 != 0) return {400, "-ERR syntax error. Expected: ... SET <field1> <value1> ..."}; std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; unsigned long long old_size = key.size() + kv_store_.at(key).size(); json doc; try { doc = json::parse(kv_store_.at(key)); } catch(...) { return {500, "-ERR not a valid JSON document"}; } if (!doc.is_array()) return {400, "-ERR `WHERE` clause can only be used on JSON arrays."}; int updated_count = 0; for (auto& item : doc) { if (item.is_object() && item.contains(where_field) && item[where_field] == where_value) { for (auto it = set_it + 1; it != args.end() && it + 1 != args.end(); it += 2) { const auto& set_field = *it; json set_value; try { set_value = json::parse(*(it + 1)); } catch(...) { set_value = *(it + 1); } item[set_field] = set_value; } updated_count++; } } if (updated_count == 0) return {200, "0"}; std::string new_dump = doc.dump(); kv_store_[key] = new_dump; estimated_memory_usage_ += (key.size() + new_dump.size()) - old_size; _update_lru(key); dirty_operations_++; _enforce_memory_limit(); if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, std::to_string(updated_count)}; }
    HandlerResult _handle_json_del(const std::vector<std::string>& args) { if (args.empty()) return {400, "-ERR wrong number of arguments"}; if (args.size() == 1) return _handle_del(args); if (args.size() != 4 || args[1] != "WHERE") return {400, "-ERR syntax: JSON.DEL <key> [WHERE <field> <value>]"}; const auto& key = args[0]; const auto& field = args[2]; json value_to_find; try { value_to_find = json::parse(args[3]); } catch (...) { value_to_find = args[3]; } std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; unsigned long long old_size = key.size() + kv_store_.at(key).size(); json doc; try { doc = json::parse(kv_store_.at(key)); } catch (...) { return {500, "-ERR not a valid JSON document"}; } if (!doc.is_array()) return {400, "-ERR WHERE clause can only be used on JSON arrays."}; auto original_array_size = doc.size(); doc.erase(std::remove_if(doc.begin(), doc.end(), [&](const json& item) { return item.is_object() && item.contains(field) && item[field] == value_to_find; }), doc.end()); auto deleted_count = original_array_size - doc.size(); if (deleted_count == 0) return {200, "0"}; std::string new_dump = doc.dump(); kv_store_[key] = new_dump; estimated_memory_usage_ += (key.size() + new_dump.size()) - old_size; _update_lru(key); dirty_operations_++; _enforce_memory_limit(); if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, std::to_string(deleted_count)}; }
    // ** UPDATED: The new high-performance, whole-word JSON search implementation **
    HandlerResult _handle_json_search(const std::vector<std::string>& args) {
        // Syntax: JSON.SEARCH <key> "<term>" [MAX <count>]
        if (args.size() != 2 && args.size() != 4) {
            return {400, "-ERR syntax: JSON.SEARCH <key> \"<term>\" [MAX <count>]"};
        }
        
        const auto& key = args[0];
        const auto& term = args[1];
        if (term.empty()) {
            return {400, "-ERR search term cannot be empty"};
        }

        size_t max_results = std::numeric_limits<size_t>::max(); // Default to all matches
        if (args.size() == 4) {
            std::string mode = args[2];
            std::transform(mode.begin(), mode.end(), mode.begin(), ::toupper);
            if (mode != "MAX") {
                return {400, "-ERR expected MAX keyword after term"};
            }
            try {
                long long count = std::stoll(args[3]);
                if (count <= 0) {
                     return {400, "-ERR MAX count must be a positive integer"};
                }
                max_results = static_cast<size_t>(count);
            } catch (...) {
                return {400, "-ERR invalid number for MAX count"};
            }
        }

        std::string result_dump;
        {
            std::shared_lock<std::shared_mutex> lock(data_mutex_);
            if (!kv_store_.count(key)) return {404, "(nil)"};

            json doc;
            try {
                doc = json::parse(kv_store_.at(key));
            } catch (...) {
                return {500, "-ERR not a valid JSON document"};
            }
            
            json results = json::array();
            
            if (doc.is_array()) {
                for (const auto& item : doc) {
                    if (results.size() >= max_results) {
                        break;
                    }
                    if (json_contains_word(item, term)) {
                        results.push_back(item);
                    }
                }
            } else {
                // If the doc is a single object or value
                if (max_results > 0 && json_contains_word(doc, term)) {
                    results.push_back(doc);
                }
            }

            if (results.empty()) {
                return {404, "(nil)"};
            }
            
            // For client-side consistency, the result is always a JSON array of matches
            result_dump = results.dump(2);
        }
        
        // Update LRU cache
        {
            std::unique_lock<std::shared_mutex> lock(data_mutex_);
            if (!kv_store_.count(key)) return {404, "(nil)"}; // Check again in case it was evicted
            _update_lru(key);
        }
        
        return {200, result_dump};
    }
    HandlerResult _handle_json_append(const std::vector<std::string>& args) { if (args.size() != 2) return {400, "-ERR wrong number of arguments. Syntax: JSON.APPEND <key> '<json_to_append>'"}; const auto& key = args[0]; std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(key)) return {404, "(nil)"}; unsigned long long old_size = key.size() + kv_store_.at(key).size(); json doc; try { doc = json::parse(kv_store_.at(key)); } catch (...) { return {500, "-ERR value at key is not a valid JSON document"}; } if (!doc.is_array()) return {400, "-ERR APPEND requires the value at key to be a JSON array"}; json new_json; try { new_json = json::parse(args[1]); } catch(const json::parse_error& e) { return {400, std::string("-ERR invalid JSON for append: ") + e.what()}; } if (new_json.is_object()) { doc.push_back(new_json); } else if (new_json.is_array()) { doc.insert(doc.end(), new_json.begin(), new_json.end()); } else { return {400, "-ERR append value must be a JSON object or array"}; } std::string new_dump = doc.dump(); kv_store_[key] = new_dump; estimated_memory_usage_ += (key.size() + new_dump.size()) - old_size; _update_lru(key); dirty_operations_++; _enforce_memory_limit(); if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, std::to_string(doc.size())}; }
    HandlerResult _handle_ttl(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR wrong number of arguments"}; std::shared_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return {404, "(nil)"}; if (!ttl_map_.count(args[0])) return {200, "-1"}; auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); long long expiry_ms = ttl_map_.at(args[0]); if (now_ms > expiry_ms) return {404, "(nil)"}; return {200, std::to_string((expiry_ms - now_ms) / 1000)}; }
    HandlerResult _handle_expire(const std::vector<std::string>& args) { if (args.size() != 2) return {400, "-ERR wrong number of arguments"}; std::unique_lock<std::shared_mutex> lock(data_mutex_); if (!kv_store_.count(args[0])) return {404, "(nil)"}; try { long long ttl_s = std::stoll(args[1]); if (ttl_s <= 0) { ttl_map_.erase(args[0]); } else { ttl_map_[args[0]] = std::chrono::duration_cast<std::chrono::milliseconds>((std::chrono::system_clock::now() + std::chrono::seconds(ttl_s)).time_since_epoch()).count(); } } catch (...) { return {400, "-ERR invalid TTL value"}; } dirty_operations_++; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, "+OK"}; }
    HandlerResult _handle_stats() { std::shared_lock<std::shared_mutex> lock(data_mutex_); int num_threads = (WORKERS_THREAD_COUNT <= 0) ? std::max(1u, std::thread::hardware_concurrency() - 1) : WORKERS_THREAD_COUNT; std::stringstream ss; ss << "Version: NukeKV v2.5-Stable ☢️ - \n"; ss << "Protocol: Nuke-Wire (CUSTOM RAW TCP)\n"; ss << "Debug Mode: " << (DEBUG_MODE.load() ? "ON" : "OFF") << "\n"; ss << "Worker Threads: " << num_threads << "\n"; ss << "-------------------------\n"; ss << "Persistence Disk: " << (PERSISTENCE_ENABLED ? "Enabled" : "Disabled") << "\n"; if (PERSISTENCE_ENABLED) { ss << "  - Batch Size: " << BATCH_PROCESSING_SIZE.load() << "\n"; ss << "  - Unsaved Ops: " << dirty_operations_.load() << "\n"; long long file_size = get_file_size(DATABASE_FILENAME); ss << "  - Disk Size: " << (file_size >= 0 ? format_memory_size(file_size) : "N/A") << "\n"; } ss << "-------------------------\n"; ss << "Caching: " << (CACHING_ENABLED ? "Enabled" : "Disabled") << "\n"; if (CACHING_ENABLED) { ss << "  - Memory Limit: " << (max_memory_bytes_ > 0 ? format_memory_size(max_memory_bytes_) : "Unlimited") << "\n"; ss << "  - Memory Used: " << format_memory_size(get_current_ram_usage()) << "\n"; } ss << "-------------------------\n"; ss << "Total Keys: " << kv_store_.size() << "\n"; ss << "Keys with TTL: " << ttl_map_.size() << "\n"; ss << "-------------------------\n"; return {200, ss.str()}; }
    HandlerResult _handle_batch(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR BATCH requires one argument"}; int new_size; try { new_size = std::stoi(args[0]); } catch(...) { return {400, "-ERR value is not an integer"}; } if (new_size < 0) return {400, "-ERR batch size cannot be negative"}; BATCH_PROCESSING_SIZE.store(new_size); return {200, "+OK"}; }
    HandlerResult _handle_debug(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR DEBUG requires one argument"}; std::string mode = args[0]; std::transform(mode.begin(), mode.end(), mode.begin(), [](unsigned char c){ return ::tolower(c); }); if (mode == "true") { DEBUG_MODE.store(true); return {200, "+OK Debug mode enabled."}; } else if (mode == "false") { DEBUG_MODE.store(false); return {200, "+OK Debug mode disabled."}; } return {400, "-ERR Invalid argument. Use 'true' or 'false'."}; }
    HandlerResult _handle_stress(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR STRESS requires one argument"}; int count; try { count = std::stoi(args[0]); } catch (...) { return {400, "-ERR invalid number"}; } if (count <= 0) return {400, "-ERR count must be positive"}; std::cout << "\n[INFO] Starting stress test" << std::endl; auto overall_start = high_res_clock::now(); std::stringstream ss; ss << "Stress Test running for " << count << " ops ...\n" << "-------------------------------------------"; { std::vector<std::string> keys(count); for(int i=0; i<count; ++i) keys[i] = "stress:" + std::to_string(i); std::unordered_map<std::string, std::string> stress_store; stress_store.reserve(count); auto run_benchmark = [&](auto op){ auto start = high_res_clock::now(); for(int i=0; i<count; ++i) op(stress_store, i); return std::chrono::duration<double>(high_res_clock::now() - start).count(); }; auto set_op = [&](auto& store, int i){ store[keys[i]] = "svalue"; }; double set_dur = run_benchmark(set_op); ss << "\n" << std::left << std::setw(8) << "SET:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count/set_dur) << " ops/sec (" << format_duration(set_dur) << " total)"; auto update_op = [&](auto& store, int i){ store[keys[i]] = "nvalue"; }; double update_dur = run_benchmark(update_op); ss << "\n" << std::left << std::setw(8) << "UPDATE:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count/update_dur) << " ops/sec (" << format_duration(update_dur) << " total)"; auto get_op = [&](auto& store, int i){ (void)store.at(keys[i]); }; double get_dur = run_benchmark(get_op); ss << "\n" << std::left << std::setw(8) << "GET:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count/get_dur) << " ops/sec (" << format_duration(get_dur) << " total)"; auto del_op = [&](auto& store, int i){ store.erase(keys[i]); }; double del_dur = run_benchmark(del_op); ss << "\n" << std::left << std::setw(8) << "DEL:" << std::right << std::setw(12) << std::fixed << std::setprecision(2) << (count/del_dur) << " ops/sec (" << format_duration(del_dur) << " total)"; } double total_time = std::chrono::duration<double>(high_res_clock::now() - overall_start).count(); ss << "\n-------------------------------------------\n" << "MAX RAM USAGE: " << format_memory_size(get_current_ram_usage()) << "\nTotal Stress Test Time: " << format_duration(total_time); std::cout << "[INFO] Stress test complete. All test data disposed from memory." << std::endl; return {200, ss.str()}; }
    HandlerResult _handle_clrdb() { std::unique_lock<std::shared_mutex> lock(data_mutex_); size_t keys_cleared = kv_store_.size(); kv_store_.clear(); ttl_map_.clear(); lru_list_.clear(); lru_map_.clear(); estimated_memory_usage_ = 0; dirty_operations_++; if (BATCH_PROCESSING_SIZE.load() == 0) _save_to_file_unlocked(DATABASE_FILENAME); return {200, "+OK " + std::to_string(keys_cleared) + " keys cleared."}; }
    HandlerResult _handle_similar(const std::vector<std::string>& args) { if (args.size() != 1) return {400, "-ERR wrong number of arguments, expected: SIMILAR <prefix>"}; const auto& prefix = args[0]; if (prefix.empty()) return {400, "-ERR prefix cannot be empty"}; std::shared_lock<std::shared_mutex> lock(data_mutex_); size_t count = 0; for (const auto& pair : kv_store_) { if (pair.first.rfind(prefix, 0) == 0) count++; } return {200, std::to_string(count)}; }

public:
    NukeKV() { if (MAX_RAM_GB > 0) max_memory_bytes_ = MAX_RAM_GB * 1024 * 1024 * 1024; int num_threads = (WORKERS_THREAD_COUNT <= 0) ? std::max(1u, std::thread::hardware_concurrency() - 1) : WORKERS_THREAD_COUNT; for (int i = 0; i < num_threads; ++i) workers_.emplace_back(&NukeKV::_worker_function, this); background_manager_thread_ = std::thread(&NukeKV::_background_manager, this); }
    ~NukeKV() { stop_all_ = true; condition_.notify_all(); for (auto& worker : workers_) if (worker.joinable()) worker.join(); if (background_manager_thread_.joinable()) background_manager_thread_.join(); if (dirty_operations_ > 0) { std::cout << "\nPerforming final save of " << dirty_operations_.load() << " operations..." << std::endl; std::unique_lock<std::shared_mutex> lock(data_mutex_); _save_to_file_unlocked(DATABASE_FILENAME); } }
    void load_from_file();
    std::future<HandlerResult> dispatch_command(const std::string& cmd, const std::vector<std::string>& args) { Task task; task.command_str = cmd; task.args = args; auto future = task.promise.get_future(); { std::lock_guard<std::mutex> lock(queue_mutex_); task_queue_.push(std::move(task)); } condition_.notify_one(); return future; }
};

void NukeKV::_worker_function() {
    const std::unordered_map<std::string, std::function<HandlerResult(const std::vector<std::string>&)>> command_map = {
        {"SET", [this](const auto&a){return _handle_set(a);}}, {"GET", [this](const auto&a){return _handle_get(a);}}, {"DEL", [this](const auto&a){return _handle_del(a);}}, {"UPDATE", [this](const auto&a){return _handle_update(a);}}, {"INCR", [this](const auto&a){return _handle_incr_decr(a,true);}}, {"DECR", [this](const auto&a){return _handle_incr_decr(a,false);}}, {"TTL", [this](const auto&a){return _handle_ttl(a);}}, {"EXPIRE", [this](const auto&a){return _handle_expire(a);}}, {"JSON.SET", [this](const auto&a){return _handle_json_set(a);}}, {"JSON.GET", [this](const auto&a){return _handle_json_get(a);}}, {"JSON.UPDATE", [this](const auto&a){return _handle_json_update(a);}}, {"JSON.SEARCH", [this](const auto&a){return _handle_json_search(a);}}, {"JSON.DEL", [this](const auto&a){return _handle_json_del(a);}}, {"JSON.APPEND", [this](const auto&a){return _handle_json_append(a);}}, {"STATS", [this](const auto&a){return _handle_stats();}}, {"STRESS", [this](const auto&a){return _handle_stress(a);}}, {"BATCH", [this](const auto&a){return _handle_batch(a);}}, {"DEBUG", [this](const auto&a){return _handle_debug(a);}}, {"CLRDB", [this](const auto&a){return _handle_clrdb();}}, {"SIMILAR", [this](const auto&a){return _handle_similar(a);}},
    };
    while (!stop_all_) { Task task; { std::unique_lock<std::mutex> lock(queue_mutex_); condition_.wait(lock, [this]{return !task_queue_.empty() || stop_all_;}); if (stop_all_ && task_queue_.empty()) return; task = std::move(task_queue_.front()); task_queue_.pop(); } try { auto it = command_map.find(task.command_str); task.promise.set_value(it != command_map.end() ? it->second(task.args) : HandlerResult{400, "-ERR unknown command '" + task.command_str + "'"}); } catch (const std::exception& e) { task.promise.set_value(HandlerResult{500, std::string("-ERR worker exception: ") + e.what()}); } catch (...) { task.promise.set_value(HandlerResult{500, "-ERR unknown worker exception"}); } }
}
void NukeKV::load_from_file() { if (!PERSISTENCE_ENABLED) return; std::ifstream ifs(DATABASE_FILENAME); if (!ifs.is_open()) { std::cout << "[INFO] Database file not found." << std::endl; return; } std::unique_lock<std::shared_mutex> lock(data_mutex_); try { json db_json; ifs >> db_json; if (db_json.count("store")) kv_store_ = db_json["store"].get<std::unordered_map<std::string, std::string>>(); if (db_json.count("ttl")) ttl_map_ = db_json["ttl"].get<std::unordered_map<std::string, long long>>(); for(const auto& pair : kv_store_){ estimated_memory_usage_ += (pair.first.size() + pair.second.size()); _update_lru(pair.first); } _enforce_memory_limit(); std::cout << "[INFO] Loaded " << kv_store_.size() << " keys." << std::endl; } catch (...) { std::cerr << "[ERROR] Could not parse database file." << std::endl; } }

// --- Command Line Parser ---
inline std::vector<std::string> parse_command_line(const std::string& line) {
    std::vector<std::string> args; if (line.empty()) return args;
    size_t cmd_end = line.find(' ');
    std::string command = (cmd_end == std::string::npos) ? line : line.substr(0, cmd_end);
    args.push_back(command);
    std::string command_upper = command;
    std::transform(command_upper.begin(), command_upper.end(), command_upper.begin(), ::toupper);
    char required_quote = 0;
    if (command_upper == "SET" || command_upper == "UPDATE") required_quote = '"';
    else if (command_upper == "JSON.SET" || command_upper == "JSON.APPEND") required_quote = '\'';
    if (required_quote != 0) {
        if (cmd_end == std::string::npos) return args;
        size_t key_start = cmd_end + 1;
        size_t value_divider_pos = line.find(' ', key_start);
        if (value_divider_pos == std::string::npos) { args.push_back(line.substr(key_start)); return args; }
        std::string key = line.substr(key_start, value_divider_pos - key_start);
        size_t value_start = line.find_first_not_of(" \t", value_divider_pos);
        size_t ex_pos = line.rfind(" EX ");
        if (ex_pos != std::string::npos && ex_pos > value_divider_pos) {
            if (line[value_start] != required_quote || ex_pos < value_start || line[ex_pos - 1] != required_quote) return args;
            args.push_back(key); args.push_back(line.substr(value_start + 1, ex_pos - value_start - 2)); args.push_back("EX"); args.push_back(line.substr(ex_pos + 4));
        } else {
             if (value_start == std::string::npos || line[value_start] != required_quote || line.back() != required_quote) return args;
             args.push_back(key); args.push_back(line.substr(value_start + 1, line.length() - value_start - 2));
        }
    } else {
        std::string current_arg; char quote_type=0; for (size_t i=cmd_end+1; i<line.length(); ++i) { char c=line[i]; if(quote_type==0 && (c=='\''||c=='"')) {if(!current_arg.empty()){args.push_back(current_arg);current_arg.clear();} quote_type=c;} else if(c==quote_type){quote_type=0;} else if(quote_type==0&&isspace(c)){if(!current_arg.empty()){args.push_back(current_arg);current_arg.clear();}} else{current_arg+=c;}} if(!current_arg.empty())args.push_back(current_arg);
        if (command_upper == "JSON.UPDATE" || command_upper == "JSON.GET") { auto transform_keywords = [](std::string& s) { std::string lower_s = s; std::transform(lower_s.begin(), lower_s.end(), lower_s.begin(), [](unsigned char c){ return ::tolower(c); }); if (lower_s == "where") s = "WHERE"; else if (lower_s == "set") s = "SET"; }; for(size_t i = 1; i < args.size(); ++i) { transform_keywords(args[i]); } }
    }
    return args;
}

// --- nuke-wire Protocol Implementation ---
inline bool send_all(socket_t sock, const char* buf, size_t len) { size_t sent=0; while(sent<len){int n=send(sock,buf+sent,len-sent,0); if(n<=0)return false; sent+=n;} return true; }
inline bool send_message(socket_t sock, const std::string& msg) { uint64_t len=msg.length(), net_len=nuke_htonll(len); if(!send_all(sock,reinterpret_cast<const char*>(&net_len),sizeof(net_len)))return false; if(len>0&&!send_all(sock,msg.c_str(),len))return false; return true; }
inline bool recv_all(socket_t sock, char* buf, size_t len) { size_t recvd=0; while(recvd<len){int n=recv(sock,buf+recvd,len-recvd,0); if(n<=0)return false; recvd+=n;} return true; }

// --- BUG FIX & ENHANCEMENT: Hardened against internet scanners and bots ---
inline bool recv_message(socket_t sock, std::string& msg) {
    uint64_t net_len;
    // If a scanner connects and disconnects, or sends garbage that isn't 8 bytes,
    // this will fail. We return false to silently close the connection without logging errors.
    if (!recv_all(sock, reinterpret_cast<char*>(&net_len), sizeof(net_len))) {
        return false;
    }

    uint64_t msg_len = nuke_ntohll(net_len);

    // This is the CRITICAL security check. If a bot sends junk (like an HTTP request),
    // the first 8 bytes will be interpreted as a massive number. This check prevents
    // the server from crashing by trying to allocate that memory.
    if (msg_len > MAX_PAYLOAD_SIZE) { 
        // We now ONLY log this if DEBUG_MODE is on, to keep production logs clean.
        if (DEBUG_MODE.load(std::memory_order_relaxed)) {
            std::cout << "[INFO] A client sent a malformed header with payload size " 
                      << format_memory_size(msg_len) << ", exceeding the " 
                      << format_memory_size(MAX_PAYLOAD_SIZE) << " limit. Connection closed." << std::endl;
        }
        return false; // Silently and safely close the connection.
    }

    if (msg_len == 0) { 
        msg.clear(); 
        return true; 
    } 
    
    try { 
        msg.resize(msg_len); 
    } catch (const std::bad_alloc&) { 
        // This is a failsafe in the unlikely event the MAX_PAYLOAD_SIZE is set too high
        // for the machine's available RAM.
        if (DEBUG_MODE.load(std::memory_order_relaxed)) {
            std::cerr << "[FATAL] Failed to allocate memory for message of " << format_memory_size(msg_len) << std::endl; 
        }
        return false; 
    } 
    
    return recv_all(sock, &msg[0], msg_len);
}


void handle_client(socket_t client_socket, NukeKV* db_engine) {
    while (true) {
        std::string command_line;
        if (!recv_message(client_socket, command_line)) {
            // This will now trigger for legitimate disconnects OR silent scanner rejections.
            break; 
        }

        auto args = parse_command_line(command_line);
        high_res_clock::time_point start_time;
        if (DEBUG_MODE.load(std::memory_order_relaxed)) {
            start_time = high_res_clock::now();
        }

        HandlerResult result_pair;
        if (args.empty()) { 
            result_pair = {400, "-ERR empty command"};
        } else {
            std::string command = args[0];
            std::transform(command.begin(), command.end(), command.begin(), [](unsigned char c){ return ::toupper(c); });
            args.erase(args.begin());

            if (command == "QUIT") { 
                result_pair = {200, "+OK Bye"}; 
                send_message(client_socket, result_pair.second); 
                break; 
            } else if (command == "PING") { 
                result_pair = {200, "+PONG"}; 
            } else { 
                auto future = db_engine->dispatch_command(command, args); 
                result_pair = future.get(); 
            }
        }
        
        std::string result_text = result_pair.second;
        if (DEBUG_MODE.load(std::memory_order_relaxed) && result_text.rfind("Stress Test", 0) != 0) {
            auto duration_s = std::chrono::duration<double>(high_res_clock::now() - start_time).count();
            result_text += " (" + format_duration(duration_s) + ")";
        }

        if (!send_message(client_socket, result_text)) {
            break;
        }
    }
    close_socket(client_socket);
}

// --- Main Application ---
int main() {
    #ifdef _WIN32
        SetConsoleOutputCP(CP_UTF8); SetConsoleCP(CP_UTF8);
        WSADATA wsaData; if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) { std::cerr << "[FATAL] WSAStartup failed." << std::endl; return 1; }
    #else
        std::setlocale(LC_ALL, "en_US.UTF-8");
    #endif

    std::future<std::string> public_ip_future = std::async(std::launch::async, get_public_ip);
    NukeKV db_engine;
    db_engine.load_from_file();
    
    socket_t listen_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_socket == INVALID_SOCKET_VAL) { std::cerr << "[FATAL] Failed to create socket." << std::endl; return 1; }

    int reuse = 1;
    setsockopt(listen_socket, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(SERVER_PORT);

    if (bind(listen_socket, (sockaddr*)&server_addr, sizeof(server_addr)) != 0) { std::cerr << "[FATAL] Bind failed on port " << SERVER_PORT << "." << std::endl; close_socket(listen_socket); return 1; }
    if (listen(listen_socket, SOMAXCONN) != 0) { std::cerr << "[FATAL] Listen failed." << std::endl; close_socket(listen_socket); return 1; }

    std::cout << R"(
     __    __  __    __  __    __  ________       __    __  __     __ 
    /  \  /  |/  |  /  |/  |  /  |/        |     /  |  /  |/  |   /  |
    $$  \ $$ |$$ |  $$ |$$ | /$$/ $$$$$$$$/      $$ | /$$/ $$ |   $$ |
    $$$  \$$ |$$ |  $$ |$$ |/$$/  $$ |__  ______ $$ |/$$/  $$ |   $$ |
    $$$$  $$ |$$ |  $$ |$$  $$<   $$    |/      |$$  $$<   $$  \ /$$/ 
    $$ $$ $$ |$$ |  $$ |$$$$$  \  $$$$$/ $$$$$$/ $$$$$  \   $$  /$$/  
    $$ |$$$$ |$$ \__$$ |$$ |$$  \ $$ |_____      $$ |$$  \   $$ $$/   
    $$ | $$$ |$$    $$/ $$ | $$  |$$       |     $$ | $$  |   $$$/    
    $$/   $$/  $$$$$$/  $$/   $$/ $$$$$$$$/      $$/   $$/     $/     
    )" << std::endl;
    std::cout << "NukeKV v2.5-stable ☢️ : Protocol: Nuke-Wire (CUSTOM RAW TCP)" << std::endl;
    std::cout << "=================================================================" << std::endl;

    std::string public_ip = (public_ip_future.wait_for(std::chrono::seconds(3)) == std::future_status::ready) ? public_ip_future.get() : "";
    
    std::cout << "Server is ready to accept connections!" << std::endl;
    std::cout << "  - Listening on: 0.0.0.0:" << SERVER_PORT << std::endl;
    if (!public_ip.empty()) std::cout << "  - Connect Publicly: " << public_ip << ":" << SERVER_PORT << std::endl;
    else std::cout << "  - Public IP: (Could not determine, check internet connection)" << std::endl;
    
    std::cout << "=================================================================" << std::endl;
    std::cout << "Press Ctrl+C to shut down." << std::endl;

    while (true) {
        socket_t client_socket = accept(listen_socket, NULL, NULL);
        if (client_socket == INVALID_SOCKET_VAL) break;
        std::thread(handle_client, client_socket, &db_engine).detach();
    }

    close_socket(listen_socket);
    #ifdef _WIN32
        WSACleanup();
    #endif

    std::cout << "\nServer shutting down gracefully." << std::endl;
    return 0;
}