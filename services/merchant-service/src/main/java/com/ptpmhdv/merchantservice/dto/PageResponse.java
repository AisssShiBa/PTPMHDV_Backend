package com.ptpmhdv.merchantservice.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.domain.Page;

import java.util.List;
import java.util.function.Function;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PageResponse<T> {
    private List<T> items;
    private long total;
    private int page;
    private int limit;

    public static <E, T> PageResponse<T> fromPage(Page<E> page, Function<E, T> mapper) {
        List<T> items = page.getContent().stream().map(mapper).toList();
        return PageResponse.<T>builder()
                .items(items)
                .total(page.getTotalElements())
                .page(page.getNumber() + 1)
                .limit(page.getSize())
                .build();
    }
}
