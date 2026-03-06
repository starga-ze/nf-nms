#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace nf::algorithm
{

class ByteRingBuffer
{
public:
    explicit ByteRingBuffer(size_t capacity);

    size_t readable() const;
    size_t writable() const;

    uint8_t* writePtr();
    size_t writeLen() const;
    void produce(size_t n);

    const uint8_t* readPtr() const;
    size_t readLen() const;
    void consume(size_t n);

    size_t write(const uint8_t* data, size_t len);
    size_t read(uint8_t* out, size_t len);

    size_t peek(uint8_t* out, size_t len) const;

    void clear();

private:
    std::vector<uint8_t> m_buffer;

    size_t m_head = 0;
    size_t m_tail = 0;
    size_t m_size = 0;
};

} // namespace nf::algorithm
