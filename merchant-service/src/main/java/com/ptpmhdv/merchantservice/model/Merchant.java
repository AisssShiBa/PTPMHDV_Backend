package com.ptpmhdv.merchantservice.model;

import com.fasterxml.jackson.annotation.JsonFormat;
import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "merchants", indexes = {
    @Index(name = "idx_merchants_status", columnList = "status"),
    @Index(name = "idx_merchants_owner_id", columnList = "ownerId")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Merchant {

    @Id
    @Column(columnDefinition = "VARCHAR(36)")
    private String id;

    @Column(nullable = false, columnDefinition = "VARCHAR(36)")
    private String ownerId;

    @Column(nullable = false)
    private String businessName;

    private String taxId;

    private String bankAccount;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    @Builder.Default
    private MerchantStatus status = MerchantStatus.PENDING;

    private Instant deletedAt;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    @Column(nullable = false)
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        this.createdAt = now;
        this.updatedAt = now;
        if (this.id == null || this.id.isBlank()) {
            this.id = UUID.randomUUID().toString();
        }
        if (this.status == null) {
            this.status = MerchantStatus.PENDING;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        this.updatedAt = Instant.now();
    }
}
